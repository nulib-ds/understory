// The publish pipeline's task worker. Every state in PublishStateMachine
// invokes this function with a `task`.
//
// Publishing a collection is two user actions, not one:
//
//   1. "Publish IIIF assets" runs this pipeline. It rewrites every member into
//      the published space AND builds the candidate search index from exactly
//      the bytes it wrote, pointing the collection's `_staged` alias at it.
//   2. "Publish search index" is then a single atomic alias flip.
//
// The candidate is built in step 1 on purpose. Building it at flip time would
// index whatever the working index holds by then — including edits made while
// the curator was rebuilding their static site — which re-opens exactly the
// drift the two-step flow exists to close.

const crypto = require("node:crypto");
const {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} = require("@aws-sdk/client-cloudfront");
const {
  manifestObjectKey,
  extractLabel,
  canvasThumbnailService,
} = require("../../../shared/manifest");
const {
  MANAGED_KEY,
  collectionObjectKey,
  rootCollectionKey,
  buildCollectionDocument,
  buildRootCollectionDocument,
  rootCollectionSummaries,
  createRootCollectionTemplate,
  manifestThumbnail,
} = require("../../../shared/collection");
const {WORKING, PUBLISHED, INTERNAL_PREFIX, spaceBase} = require("../../../shared/space");
const {
  CONTENT_HASH_KEY,
  contentHash,
  publishDocument,
  externalImageServices,
  planPublish,
  stageActions,
  supersededCandidates,
} = require("../../../shared/publish");
const {
  publishedIndexName,
  liveAliasName,
  stagedAliasName,
  workingIndexName,
  SYNC_PUBLISHED,
  PUBLISHED_INDEX_PROPERTIES,
  buildPublishedDocument,
} = require("../../../shared/search");
const {
  createIndexExclusive,
  bulkUpsert,
  bulkScriptedUpdate,
  updateAliases,
  getAliases,
  deleteIndex,
} = require("../../../shared/opensearch");
const {readJson, putJson, listKeys} = require("./s3io");

const baseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");
const imageApiBase = (process.env.IMAGE_API_BASE_URL || "").replace(/\/$/, "");
const prefix = process.env.SEARCH_INDEX_PREFIX || "";
const WORKING_BASE = spaceBase(baseUrl, WORKING);
// The collection builders append the space themselves, so they take the bare
// base while the URL rewrite takes the space-qualified one.
const PUBLISHED_BASE_ROOT = baseUrl;
const PUBLISHED_BASE = spaceBase(baseUrl, PUBLISHED);

const BATCH_SIZE = 25;

const runPrefix = (slug, runId) => `${INTERNAL_PREFIX}/publish/${slug}/${runId}`;
const planKeyFor = (slug, runId) => `${runPrefix(slug, runId)}/plan.json`;
const batchKeyFor = (slug, runId, index) => `${runPrefix(slug, runId)}/batches/${index}.json`;
const statusKeyFor = (slug) => `${INTERNAL_PREFIX}/publish/${slug}/status.json`;

async function writeStatus(slug, status) {
  await putJson(statusKeyFor(slug), {...status, slug, updatedAt: new Date().toISOString()});
}

// --- plan ------------------------------------------------------------------

async function plan({slug, runId, requestedBy}) {
  const [workingLeaf, publishedLeaf] = await Promise.all([
    readJson(collectionObjectKey(slug, WORKING)),
    readJson(collectionObjectKey(slug, PUBLISHED)),
  ]);
  if (!workingLeaf) {
    throw new Error(`No working collection document for ${slug}`);
  }

  // Each working member needs its current hash, which means reading it. The
  // read is not wasted: the batch that publishes it reads it again only if it
  // has changed.
  const workingMembers = [];
  for (const item of workingLeaf.document.items || []) {
    const workId = workIdFromManifestUrl(item.id);
    if (!workId) continue;
    const stored = await readJson(manifestObjectKey(workId, WORKING));
    if (!stored) continue;
    workingMembers.push({workId, contentHash: contentHash(stored.bytes)});
  }

  const publishedMembers = (publishedLeaf?.document.items || []).map((item) => ({
    workId: workIdFromManifestUrl(item.id),
    [CONTENT_HASH_KEY]: item[CONTENT_HASH_KEY] || null,
  }));

  const diff = planPublish({workingMembers, publishedMembers});
  const toWrite = [...diff.adds, ...diff.changes];

  // The plan is an S3 object, not the state payload: a Step Functions state is
  // capped at 256KB and a large collection blows straight past it.
  await putJson(planKeyFor(slug, runId), {
    slug,
    runId,
    members: workingMembers,
    write: toWrite.map((member) => member.workId),
    removes: diff.removes.map((member) => member.workId),
  });

  const indexName = publishedIndexName(prefix, slug, runId);
  // Must fail if it exists. Two runs starting in the same instant must not
  // both believe they own the candidate; the loser has to find out.
  await createIndexExclusive(indexName, PUBLISHED_INDEX_PROPERTIES);

  const batches = Math.ceil(workingMembers.length / BATCH_SIZE);
  await writeStatus(slug, {
    runId,
    requestedBy: requestedBy || null,
    status: "running",
    phase: "Publishing works…",
    total: workingMembers.length,
    batches,
    written: 0,
    indexName,
    startedAt: new Date().toISOString(),
  });

  return {
    slug,
    runId,
    indexName,
    total: workingMembers.length,
    batches: Array.from({length: batches}, (_, i) => i),
  };
}

function workIdFromManifestUrl(url) {
  const match = /\/presentation\/manifest\/([^/]+)\/manifest\.json$/.exec(url || "");
  return match ? match[1] : null;
}

// --- batch -----------------------------------------------------------------

// One slice of the plan. Writes its OWN result object rather than updating a
// shared status: each batch owns a distinct key, so there is no write
// contention and the UI can count keys to get progress.
async function batch({slug, runId, indexName, batchIndex}) {
  const planned = await readJson(planKeyFor(slug, runId));
  if (!planned) throw new Error(`Plan missing for ${slug}/${runId}`);
  const {members, write} = planned.document;
  const toWrite = new Set(write);
  const slice = members.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);

  const results = [];
  const searchDocs = [];
  for (const member of slice) {
    try {
      const stored = await readJson(manifestObjectKey(member.workId, WORKING));
      if (!stored) {
        // Deleted while the run was walking. Drop it from the member list
        // rather than failing the batch.
        results.push({workId: member.workId, status: "gone"});
        continue;
      }
      const hash = contentHash(stored.bytes);
      const {document, replacements} = publishDocument(stored.document, {
        from: WORKING_BASE,
        to: PUBLISHED_BASE,
        strip: [MANAGED_KEY],
      });
      if (replacements === 0) {
        throw new Error("No self-referential URLs found — is this manifest under the working base?");
      }
      if (toWrite.has(member.workId)) {
        await putJson(manifestObjectKey(member.workId, PUBLISHED), document);
      }
      const items = Array.isArray(document.items) ? document.items : [];
      results.push({
        workId: member.workId,
        status: "ok",
        contentHash: hash,
        manifestId: document.id,
        label: extractLabel(document.label),
        thumbnail: manifestThumbnail(document) || null,
        external: externalImageServices(document, imageApiBase).length,
      });
      searchDocs.push({
        workId: member.workId,
        ...buildPublishedDocument({
          manifestUrl: document.id,
          label: extractLabel(document.label),
          thumbnails: items.map(canvasThumbnailService).filter(Boolean).slice(0, 5),
          itemCount: items.length,
        }),
      });
    } catch (error) {
      console.error(`Publish failed for ${member.workId}`, error);
      results.push({workId: member.workId, status: "failed", error: error.message});
    }
  }

  if (searchDocs.length) {
    // No wait_for here: nothing reads the candidate index until the alias
    // flip, so paying a refresh interval per batch would only slow the run.
    await bulkUpsert(indexName, searchDocs, undefined, {waitFor: false});
  }
  await putJson(batchKeyFor(slug, runId, batchIndex), {batchIndex, results});
  return {batchIndex, count: results.length};
}

// --- write the published collection ----------------------------------------

// Built from what the batches ACTUALLY did, never from the plan. A work whose
// manifest write failed is simply absent, so the published collection can
// never advertise a document that 404s — the invariant applyReconciliation
// protects in the working space, held here too.
async function writeCollection({slug, runId}) {
  const keys = await listKeys(`${runPrefix(slug, runId)}/batches/`);
  const results = [];
  for (const key of keys) {
    const stored = await readJson(key);
    for (const result of stored?.document.results || []) results.push(result);
  }
  const published = results.filter((result) => result.status === "ok");

  const workingRoot = await readJson(rootCollectionKey(WORKING));
  const label =
    rootCollectionSummaries(workingRoot?.document || {}).find((entry) => entry.slug === slug)?.label || slug;

  // Built with the same builders as the working leaf, passing the published
  // base — so it is by construction what that code would have produced, rather
  // than a URL-transformed copy of the working document.
  const leaf = buildCollectionDocument({
    baseUrl: PUBLISHED_BASE_ROOT,
    space: PUBLISHED,
    slug,
    label,
    members: published.map((result) => ({
      manifestId: result.manifestId,
      label: result.label,
      thumbnail: result.thumbnail,
    })),
  });
  // The record of what is live: each member carries the hash of the working
  // bytes it was made from, which is what the next diff compares against.
  leaf.items = leaf.items.map((item, i) => ({
    ...item,
    [CONTENT_HASH_KEY]: published[i]?.contentHash || null,
  }));
  await putJson(collectionObjectKey(slug, PUBLISHED), leaf);

  // Leaf first, then the root — the published root must never advertise a
  // collection whose document is not there yet.
  const existingRoot = await readJson(rootCollectionKey(PUBLISHED));
  const rootDoc =
    existingRoot?.document ||
    createRootCollectionTemplate({baseUrl: PUBLISHED_BASE_ROOT, space: PUBLISHED});
  const others = rootCollectionSummaries(rootDoc).filter((entry) => entry.slug !== slug);
  await putJson(
    rootCollectionKey(PUBLISHED),
    buildRootCollectionDocument({
      baseUrl: PUBLISHED_BASE_ROOT,
      space: PUBLISHED,
      collections: [...others, {slug, label, itemCount: leaf.items.length, thumbnail: leaf.thumbnail}].sort(
        (a, b) => a.label.localeCompare(b.label),
      ),
    }),
  );


  // Mark each published work as in sync — guarded on the hash actually
  // published. A save that landed while this run was walking has a different
  // hash by now, so the guard leaves it "changed" instead of quietly claiming
  // it is published. That guard is what lets the run take no lock at all.
  //
  // Painless `==` on a String is null-safe .equals(), not reference identity.
  const marked = await bulkScriptedUpdate(
    workingIndexName(prefix),
    published.map((result) => ({
      id: result.workId,
      script: {
        source:
          "if (ctx._source.contentHash == params.hash) { ctx._source.syncState = params.state }",
        lang: "painless",
        params: {hash: result.contentHash, state: SYNC_PUBLISHED},
      },
    })),
  );

  return {
    slug,
    runId,
    published: published.length,
    marked: marked.updated,
    failed: results.filter((r) => r.status === "failed").length,
    gone: results.filter((r) => r.status === "gone").length,
    external: published.reduce((sum, r) => sum + (r.external || 0), 0),
  };
}

// --- finalize --------------------------------------------------------------

async function finalize({slug, runId, indexName, result}) {
  // Point the staged alias at the candidate, and take it off whatever run it
  // was on before (see stageActions). The live alias does not move — that is
  // the second button.
  const stagedAlias = stagedAliasName(prefix, slug);
  const [previouslyStaged, live] = await Promise.all([
    getAliases(stagedAlias).then(Object.keys),
    getAliases(liveAliasName(prefix, slug)).then(Object.keys),
  ]);
  await updateAliases(stageActions({index: indexName, stagedAlias, previouslyStaged}));
  // This write replaces the status whole, so carry over what Invalidate
  // recorded on it rather than dropping the run's only record of the CDN.
  const {cdn} = (await readJson(statusKeyFor(slug)))?.document || {};
  await writeStatus(slug, {
    runId,
    status: result?.failed ? "partial" : "succeeded",
    phase: "Done",
    ...result,
    ...(cdn ? {cdn} : {}),
    indexName,
    stagedIndex: indexName,
    finishedAt: new Date().toISOString(),
  });
  await dropSuperseded(supersededCandidates({index: indexName, previouslyStaged, live}));
  return {slug, runId, ...result};
}

// Best effort, like the CDN invalidation: the run is complete and correct
// once the alias has moved, and a leftover index costs shards, not
// correctness. After the status write, so a failure here cannot mark a
// finished run failed.
async function dropSuperseded(indexNames) {
  for (const name of indexNames) {
    try {
      await deleteIndex(name);
    } catch (error) {
      console.error(`Unable to delete superseded candidate ${name}`, error);
    }
  }
}

async function recordFailure({slug, runId, indexName, error}) {
  await writeStatus(slug, {
    runId,
    status: "failed",
    phase: "Failed",
    error: typeof error === "string" ? error : error?.Cause || error?.Error || "Publish failed",
    finishedAt: new Date().toISOString(),
  });
  return {slug, runId, failed: true};
}

// --- invalidate ------------------------------------------------------------

// published/ is cached hard at the edge (PublishedCachePolicy in template.yml),
// so until that cache is dropped a consuming site keeps serving the previous
// run's bytes no matter what this run wrote.
//
// ONE wildcard path, deliberately. A wildcard counts as a single invalidation
// path however many objects it matches, and the free allowance — 1,000 paths a
// month — is shared across every distribution in the whole ACCOUNT, not just
// this stack. Naming each published object instead would spend a 271-work
// collection's share of that allowance on a single run.
//
// It cannot be narrowed to the collection either: manifests are keyed by work
// id rather than by collection (published/presentation/manifest/{workId}/), so
// a collection-scoped run touches an arbitrary subset of that prefix.
// Over-invalidating only costs some re-fetches from an S3 origin.
const INVALIDATION_PATH = "/published/*";
const POLL_INTERVAL_MS = 5000;
const POLL_ATTEMPTS = 24;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// writeStatus replaces the object wholesale, and this task runs between two
// states that own most of its fields — so read, merge, write.
// readJson hands back {document, bytes, etag}; the patch goes on the document.
// Spreading the wrapper instead wrote a status with no top-level `status`, so
// the panel lost track of a run while its CDN cache cleared, and the `cdn`
// outcome nested itself one level deeper with every patch.
async function patchStatus(slug, patch) {
  const current = (await readJson(statusKeyFor(slug)))?.document || {};
  await writeStatus(slug, {...current, ...patch});
}

// Nothing in here is allowed to fail the run. By the time this task is reached
// every published byte is written and durable; a stale edge cache is hygiene,
// not correctness. So the outcome is recorded on the status object — where the
// UI already polls — and the task returns normally either way. The state
// machine's Catch stays as a backstop for the things this cannot catch, like a
// Lambda timeout.
async function invalidate({slug, runId}) {
  const distributionId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
  if (!distributionId) {
    return {invalidated: false, reason: "no distribution configured"};
  }

  try {
    await patchStatus(slug, {phase: "Clearing the CDN cache…"});
    const client = new CloudFrontClient({});

    // runId as the caller reference makes this idempotent: on a retry
    // CloudFront returns the invalidation it already has rather than starting a
    // second one and charging for a second path.
    const created = await client.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: runId,
          Paths: {Quantity: 1, Items: [INVALIDATION_PATH]},
        },
      }),
    );

    const invalidationId = created.Invalidation?.Id || null;
    let status = created.Invalidation?.Status || "InProgress";

    for (let attempt = 0; attempt < POLL_ATTEMPTS && status !== "Completed"; attempt += 1) {
      await sleep(POLL_INTERVAL_MS);
      const current = await client.send(
        new GetInvalidationCommand({DistributionId: distributionId, Id: invalidationId}),
      );
      status = current.Invalidation?.Status || status;
    }

    // Not an error: an invalidation that is still running will finish on its
    // own. The id is recorded so it can be chased if anyone needs to.
    const completed = status === "Completed";
    await patchStatus(slug, {cdn: {invalidationId, status, completed}});
    return {invalidated: true, invalidationId, status};
  } catch (error) {
    console.error("CDN invalidation failed", error);
    await patchStatus(slug, {cdn: {invalidated: false, error: error.message}}).catch(() => {});
    return {invalidated: false, error: error.message};
  }
}

const TASKS = {plan, batch, writeCollection, invalidate, finalize, recordFailure};

exports.handler = async (event) => {
  const task = TASKS[event?.task];
  if (!task) throw new Error(`Unknown publish task: ${event?.task}`);
  return task(event);
};

exports.newRunId = () => crypto.randomBytes(6).toString("hex");
exports.BATCH_SIZE = BATCH_SIZE;
