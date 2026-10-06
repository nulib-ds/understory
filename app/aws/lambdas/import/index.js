// The task worker behind ImportStateMachine: bring in a whole IIIF Collection
// and every work in it.
//
//   Plan ─→ ImportWorks ─→ WriteCollection ─→ Finalize
//             (Map, MaxConcurrency 5)
//
// Modelled on app/aws/lambdas/publish/index.js, which solves the same problems
// at the same scale, and dispatched the same way — on a `task` parameter.
//
// A Step Function rather than the self-invoke chain in importAssets.js because
// collections run to thousands of works: AGENTS.md already says that when
// import needs to scale, the pattern to copy is PublishStateMachine.
//
// It requires across lambda directories (../manifest/store, ../publish/s3io).
// That resolves because every function shares one esbuild code root
// (`CodeUri: ../`), and for store.js it is mandatory rather than convenient:
// that module is THE single manifest writer, and a private copy here is exactly
// how a read model once silently stopped tracking imported works.
const crypto = require("node:crypto");
const {
  ImportError,
  fetchSourceDocument,
  collectionMembers,
  imageCanvasesOnly,
  localizeStructuralIds,
} = require("../../../shared/sourceFetch");
const {buildManifestId, extractLabel} = require("../../../shared/manifest");
const {
  applyCollections,
  stripForeignManagedEntries,
  buildCollectionDocument,
  buildRootCollectionDocument,
  buildManifestReference,
  memberFromManifest,
  memberFromReference,
  membersOf,
  collectionObjectKey,
  rootCollectionKey,
  rootCollectionSummaries,
  sortMembers,
} = require("../../../shared/collection");
const {INTERNAL_PREFIX} = require("../../../shared/space");
const {progressKey} = require("../../../shared/importProgress");
const {copyCanvasAsset, copyManifestThumbnail} = require("../../../shared/assetCopy");
const {readJson, putJson, listKeys} = require("../publish/s3io");
// store.js's writeManifest, NOT shared/manifest.js's — the shared one takes its
// own {s3, bucket}; this is the wired single manifest writer.
const {writeManifest} = require("../manifest/store");
// The conditional collection-document writes the manifest API uses, so this
// run's one write of the leaf and root cannot undo a save landing beside it.
const {
  readVersioned,
  writeVersioned,
  withWriteRetry,
  ensureRoot,
  updateRoot,
} = require("../manifest/collectionStore");

const baseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");

// Ten works a Map iteration, NOT one. A STANDARD execution has a 25,000-event
// history limit and each iteration costs roughly six events, so one work per
// iteration would cap out near 4,000 works and a large collection would die
// mid-run with nothing wrong with it. Ten keeps a 10,000-work import at ~1,000
// iterations. Publish batches at 25 for the same reason.
//
// The works in a batch are imported ONE AT A TIME, so with MaxConcurrency 5 the
// load on the source is 5 works x CANVAS_CONCURRENCY, not 50 works.
const BATCH_SIZE = 10;

// Canvases in flight within one work — the same sliding window importAssets.js
// uses. 5 batches x 10 canvases is ~50 concurrent requests at the source,
// whatever the size of the collection.
const CANVAS_CONCURRENCY = 10;

// Stop starting new works after this much of the 900s timeout, leaving room for
// the one in flight (a conversion poll can run to 280s). Whatever is left is
// written to the batch result as `deferred` and reported by Finalize; because
// the work ids were minted in Plan, re-running the batch is idempotent.
const BATCH_BUDGET_MS = 540000;

const runPrefix = (slug, runId) => `${INTERNAL_PREFIX}/collection-import/${slug}/${runId}`;
const planKeyFor = (slug, runId) => `${runPrefix(slug, runId)}/plan.json`;
const batchKeyFor = (slug, runId, index) => `${runPrefix(slug, runId)}/works/${index}.json`;
// A work's marker; see shared/importProgress.js. `index` is its place in the plan.
const markerKeyFor = (slug, runId, index, state) =>
  progressKey(`${runPrefix(slug, runId)}/`, index, state);
const statusKeyFor = (slug) => `${INTERNAL_PREFIX}/collection-import/${slug}/status.json`;

async function patchStatus(slug, patch) {
  const existing = await readJson(statusKeyFor(slug));
  await putJson(statusKeyFor(slug), {
    ...(existing?.document || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

// Every work id is minted HERE, before a single byte is fetched, and written to
// plan.json. That is what makes a retry idempotent: batch 7 always owns the same
// ids, so re-running it overwrites the same manifest objects instead of minting
// a second copy of every work. Only the batch indices go into the state payload,
// which is what keeps it kilobytes against the 256KB limit.
async function plan({slug, runId, sourceUrl}) {
  const collection = await fetchSourceDocument(sourceUrl, {expect: "Collection"});
  const {manifests, skippedCollections} = collectionMembers(collection);

  const works = manifests.map((member) => ({
    workId: crypto.randomUUID(),
    sourceUrl: member.id,
    label: extractLabel(member.label),
  }));

  // The label each work's partOf will carry is the one the CURATOR chose when
  // the collection was created a moment ago — which they may well have edited
  // away from the source's — so it is read from the root register, the same
  // place canonicalizeCollectionLabels reads it. Resolved once here and carried
  // in the plan so no batch has to re-read the root.
  const root = await readJson(rootCollectionKey());
  const collectionLabel =
    rootCollectionSummaries(root?.document || {}).find((entry) => entry.slug === slug)?.label || slug;

  await putJson(planKeyFor(slug, runId), {
    slug,
    runId,
    sourceUrl,
    collectionLabel,
    works,
    skippedCollections,
  });

  const batches = Math.ceil(works.length / BATCH_SIZE);
  await patchStatus(slug, {
    status: works.length ? "running" : "complete",
    runId,
    sourceUrl,
    total: works.length,
    skippedCollections,
    startedAt: new Date().toISOString(),
  });

  return {
    total: works.length,
    skippedCollections,
    batches: Array.from({length: batches}, (_, i) => i),
  };
}

// ---------------------------------------------------------------------------
// One work
// ---------------------------------------------------------------------------

// Copies a work's canvases with a sliding window: the moment one finishes the
// next starts, so a single slow conversion holds up nothing but itself.
async function copyCanvases(workId, items) {
  const failures = [];
  let next = 0;
  const running = new Map();

  const runCanvas = async (index) => {
    try {
      await copyCanvasAsset({identifier: workId, canvasIndex: index, canvas: items[index]});
    } catch (error) {
      console.error(`Collection import: canvas ${index} of ${workId} failed`, error);
      failures.push({canvasIndex: index, error: error.message});
    } finally {
      running.delete(index);
    }
  };

  const pump = () => {
    while (running.size < CANVAS_CONCURRENCY && next < items.length) {
      const index = next;
      next += 1;
      running.set(index, runCanvas(index));
    }
  };

  pump();
  while (running.size) {
    await Promise.race(running.values());
    pump();
  }
  return failures;
}

async function importOneWork({slug, collectionLabel, work}) {
  const source = await fetchSourceDocument(work.sourceUrl, {expect: "Manifest"});
  const {items, dropped} = imageCanvasesOnly(source);

  // The source institution's own partOf is kept verbatim as provenance; only
  // entries claiming to be ours while pointing somewhere we do not own are
  // dropped. Membership in OUR collection is then written into partOf — which
  // is the authority. The collection document is a projection, rebuilt once at
  // the end, so nothing here touches a shared object.
  // localizeStructuralIds re-mints every canvas, page and annotation id off the
  // manifest's own, so nothing inside still claims the source's identity.
  let manifest = localizeStructuralIds(
    stripForeignManagedEntries(
      {...source, id: buildManifestId(baseUrl, work.workId), items},
      {baseUrl},
    ),
  );
  manifest = applyCollections(manifest, {
    baseUrl,
    collections: [{slug, label: collectionLabel}],
  });

  // skipCollection on both writes: the collection document is built ONCE, by
  // WriteCollection, from the task results. Refreshing it per work would be
  // thousands of read-modify-writes of one object — see writeCollection.
  await writeManifest(work.workId, manifest, {skipCollection: true});

  const failures = await copyCanvases(work.workId, items);
  // The source's designated thumbnail, copied as its own image rather than
  // replaced by a canvas's. Removed if it cannot be copied; see
  // copyManifestThumbnail.
  const thumbnailCopy = await copyManifestThumbnail({identifier: work.workId, manifest});
  // writeManifest hands back what it actually stored, @context normalized, and
  // the hash of those bytes — which is what publish diffs against, so it must
  // never be the hash of the in-memory copy.
  const written = await writeManifest(work.workId, manifest, {skipCollection: true});

  return {
    workId: work.workId,
    // manifestId, label, thumbnail, contentHash, itemCount, thumbnailService:
    // everything WriteCollection needs to build this work's member entry.
    ...memberFromManifest(written.manifest, {contentHash: written.contentHash}),
    canvases: items.length,
    droppedAV: dropped,
    // A canvas that failed to copy still points at the source, so the work is
    // recorded as imported-with-failures rather than silently "ok".
    status: failures.length ? "partial" : "ok",
    failures,
    thumbnailCopy: thumbnailCopy.status,
  };
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

async function batch({slug, runId, batchIndex}) {
  const stored = await readJson(planKeyFor(slug, runId));
  if (!stored) throw new Error(`No plan for ${slug}/${runId}`);
  const {works = [], collectionLabel = slug} = stored.document;
  const slice = works.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);

  // A marker for each work as it starts and as it ends, so the page can show
  // every work's state rather than only "batch 3 of 7". Best effort: a marker
  // that fails to write costs a row showing the wrong state for a moment, and
  // must never fail a work that imported fine.
  const mark = async (position, state, body = {}) => {
    try {
      await putJson(markerKeyFor(slug, runId, batchIndex * BATCH_SIZE + position, state), body);
    } catch (error) {
      console.error(`Collection import: could not write a ${state} marker`, error);
    }
  };

  const deadline = Date.now() + BATCH_BUDGET_MS;
  const results = [];
  for (const [position, work] of slice.entries()) {
    if (Date.now() > deadline) {
      results.push({workId: work.workId, sourceUrl: work.sourceUrl, status: "deferred"});
      await mark(position, "deferred");
      continue;
    }
    await mark(position, "importing");
    try {
      const result = await importOneWork({slug, collectionLabel, work});
      results.push(result);
      await mark(position, result.status);
    } catch (error) {
      // A source that is throttling us or momentarily down is not this work's
      // fault, and recording the rest of the batch as permanently failed because
      // it asked us to slow down would be wrong. Let it out: no result object is
      // written, so the state machine's Retry backs off and re-runs the whole
      // batch — idempotently, because the ids were minted in Plan.
      if (error?.retryable) {
        console.error(`Collection import: source unavailable, backing off (${work.sourceUrl})`, error);
        throw error;
      }
      console.error(`Collection import: work ${work.workId} (${work.sourceUrl}) failed`, error);
      results.push({
        workId: work.workId,
        sourceUrl: work.sourceUrl,
        status: "failed",
        error: error.message,
      });
      await mark(position, "failed", {error: error.message});
    }
  }

  // Each batch owns a distinct key, so nothing contends and progress is just a
  // count of these objects — which is also what lets a page reload pick a run
  // back up.
  await putJson(batchKeyFor(slug, runId, batchIndex), {batchIndex, results});
  return {batchIndex, imported: results.filter((r) => r.status !== "failed").length};
}

// ---------------------------------------------------------------------------
// WriteCollection
// ---------------------------------------------------------------------------

async function readResults(slug, runId) {
  const keys = await listKeys(`${runPrefix(slug, runId)}/works/`);
  const results = [];
  for (const key of keys) {
    const stored = await readJson(key);
    for (const result of stored?.document?.results || []) results.push(result);
  }
  return results;
}

// Built from what the batches ACTUALLY did, never from the plan. A work whose
// write failed is simply absent, so the collection can never advertise a
// manifest that 404s. Lifted from publish's writeCollection for that reason.
//
// This is the run's ONLY write of the collection document, which is what keeps
// the run itself free of write contention. Per-work reconciliation (fileNewWork)
// would be thousands of read-modify-writes of these same two objects, five
// batches at a time. The cost is that works appear in the works list only once
// this has run, not one by one as they land; the progress banner covers the
// wait.
async function writeCollection({slug, runId}) {
  const results = await readResults(slug, runId);
  const landed = results.filter((r) => r.status === "ok" || r.status === "partial");
  const landedIds = new Set(landed.map((r) => r.manifestId));

  const root = await ensureRoot();
  const label = rootCollectionSummaries(root).find((entry) => entry.slug === slug)?.label || slug;

  // Every work this run landed, plus any member the leaf already has that the
  // run did not produce: a work moved in on its own page while the run walked,
  // say. The leaf is what the works list and publish read, so a document built
  // from the results alone would make such a work vanish from both.
  //
  // Sorted the way reconciliation sorts, so "first member" — whose thumbnail
  // the collection borrows — means the same thing however the document was
  // produced, and a later reindex does not silently change the picture.
  // Conditional, because a curator's save can be rewriting this leaf right now.
  const leaf = await withWriteRetry(async () => {
    const current = await readVersioned(collectionObjectKey(slug));
    const others = membersOf(current?.document).filter((item) => !landedIds.has(item.id));
    const members = sortMembers([...landed.map(buildManifestReference), ...others]).map(memberFromReference);
    const document = buildCollectionDocument({baseUrl, slug, label, members});
    await writeVersioned(collectionObjectKey(slug), document, current?.etag || null);
    return document;
  });

  // Leaf first, then the root — the root must never advertise a collection
  // whose document is not there yet. The collection is already registered (it
  // was created empty when the run started); this only refreshes its count and
  // borrowed thumbnail.
  await updateRoot((current) =>
    buildRootCollectionDocument({
      baseUrl,
      collections: [
        ...rootCollectionSummaries(current).filter((entry) => entry.slug !== slug),
        {slug, label, itemCount: leaf.items.length, thumbnail: leaf.thumbnail || null},
      ].sort((a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug)),
    }),
  );

  return {
    imported: landed.length,
    failed: results.filter((r) => r.status === "failed").length,
    deferred: results.filter((r) => r.status === "deferred").length,
    partial: results.filter((r) => r.status === "partial").length,
    droppedAV: results.reduce((sum, r) => sum + (r.droppedAV || 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Finalize / RecordFailure
// ---------------------------------------------------------------------------

async function finalize({slug, result}) {
  const incomplete = (result?.failed || 0) + (result?.deferred || 0);
  await patchStatus(slug, {
    status: incomplete ? "incomplete" : "complete",
    ...result,
    completed: result?.imported || 0,
    finishedAt: new Date().toISOString(),
  });
  return {ok: true};
}

// A run that died part-way has still FILED every work it landed: each one's
// partOf names this collection, which is the authority. So build the
// collection document from those results, exactly as WriteCollection would
// have, or they would be missing from the works list (and from publishing)
// until a reindex. Best effort: recording the failure matters more.
async function recordFailure({slug, runId, error}) {
  try {
    await writeCollection({slug, runId});
  } catch (writeError) {
    console.error(`Collection import: could not write ${slug} from a failed run's results`, writeError);
  }
  await patchStatus(slug, {
    status: "failed",
    error: error?.Cause || error?.Error || "The import run did not complete",
    finishedAt: new Date().toISOString(),
  });
  return {ok: true};
}

const TASKS = {plan, batch, writeCollection, finalize, recordFailure};

exports.handler = async (event) => {
  const task = TASKS[event?.task];
  if (!task) throw new Error(`Unknown import task: ${event?.task}`);
  try {
    return await task(event);
  } catch (error) {
    // An ImportError carries an HTTP status that means nothing here; unwrap it
    // so the state machine's Cause is the message a curator would have seen.
    if (error instanceof ImportError) throw new Error(error.message);
    throw error;
  }
};

exports.BATCH_SIZE = BATCH_SIZE;
