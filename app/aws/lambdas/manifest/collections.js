// Collection reconciliation and the /collections routes.
//
// Membership is authoritative in each manifest's `partOf`. The documents under
// `presentation/collection/` are a derived projection: maintained incrementally
// here, and rebuildable from the manifests alone by reindexCollections.
//
// planReconciliation is pure and does the thinking; applyReconciliation does the
// IO in a deliberate order. That split is what makes this testable without
// mocking the SDK.
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const {listManifestSummaries} = require("../../../shared/manifest");
const {extractLabel} = require("../../../shared/language");
const {
  COLLECTION_PREFIX,
  COLLECTION_OBJECT,
  ROOT_COLLECTION_SLUG,
  MAX_COLLECTIONS_PER_WORK,
  CollectionNameError,
  sanitizeCollectionLabel,
  sanitizeCollectionSlug,
  collectionObjectKey,
  rootCollectionKey,
  managedCollectionRefs,
  applyCollections,
  buildCollectionDocument,
  buildRootCollectionDocument,
  createRootCollectionTemplate,
  rootCollectionSummaries,
  serializeCollection,
  planReconciliation,
  canonicalizeCollectionLabels,
  manifestThumbnail,
} = require("../../../shared/collection");
const {jsonResponse, parseBody, isNotFound} = require("./http");
const {WORKING, spaceKey} = require("../../../shared/space");
const {listWorks, syncCounts, rebuild: rebuildWorkIndex, documentFor: workDocument} = require("./workIndex");
const {handlePublishRoute} = require("./publishRoutes");
const {handleCollectionImportRoute} = require("./importRoutes");
const {
  canReindex,
  canMoveWork,
  canViewCollection,
  canManageCollections,
} = require("../../../shared/access");
const {readImportStatus} = require("./importAssets");

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;
const baseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// S3 access
// ---------------------------------------------------------------------------

async function streamToString(body) {
  if (typeof body === "string") return body;
  if (body && typeof body.transformToString === "function") return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(key) {
  try {
    const response = await s3.send(new GetObjectCommand({Bucket: bucket, Key: key}));
    return JSON.parse(await streamToString(response.Body));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeJson(key, document) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: serializeCollection(document),
      ContentType: "application/json",
    }),
  );
}

async function readRoot() {
  return readJson(rootCollectionKey());
}

// The root must be materialized, not synthesized on read: it is publicly
// dereferenceable and a downstream consumer must not get a 404. IfNoneMatch
// makes this a true create-if-absent, so two racing requests can't fight.
async function ensureRoot() {
  const existing = await readRoot();
  if (existing) return existing;

  const template = createRootCollectionTemplate({baseUrl});
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: rootCollectionKey(),
        Body: serializeCollection(template),
        ContentType: "application/json",
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    // Someone else created it between our read and our write. Theirs is fine.
    if (error?.$metadata?.httpStatusCode !== 412 && error?.name !== "PreconditionFailed") {
      throw error;
    }
    return (await readRoot()) || template;
  }
  return template;
}

// Order matters: every surviving leaf, then the root, then the deletions. That
// keeps `root ⊆ existing leaf documents` true at every intermediate state, so a
// crash can never leave the root advertising a collection that 404s.
async function applyReconciliation(plan) {
  // Between phases the order is the invariant — leaves, then root, then
  // deletions, so the root never advertises a document that 404s. Within a
  // phase the objects are independent, so they go in parallel.
  await Promise.all(plan.leafWrites.map((write) => writeJson(write.key, write.document)));
  if (plan.rootChanged) {
    await writeJson(rootCollectionKey(), plan.rootNext);
  }
  await Promise.all(
    plan.leafDeletes.map((removal) =>
      s3.send(new DeleteObjectCommand({Bucket: bucket, Key: removal.key})),
    ),
  );
  return {written: plan.leafWrites.length, deleted: plan.leafDeletes.length};
}


// Bring the projection in line with one manifest.
//
//   desired === null  -> membership unchanged; refresh cached labels/thumbnails
//   desired === []    -> remove from everything (used by the delete path)
//   removed           -> the manifest itself is gone
async function reconcileManifestCollections({
  manifest,
  desired = null,
  previous,
  removed = false,
  root: knownRoot,
}) {
  // `previous` must describe the membership as it was BEFORE the manifest was
  // updated. Deriving it from an already-updated manifest silently drops every
  // removal out of the touched set, leaving the abandoned collection behind
  // until the next reindex.
  const current = previous || managedCollectionRefs(manifest?.partOf, {baseUrl});
  const target = desired === null ? current : desired;

  const root = knownRoot || (await ensureRoot());
  const touched = new Set([...current.map((ref) => ref.slug), ...target.map((ref) => ref.slug)]);
  if (!touched.size) {
    return {ok: true, written: 0, deleted: 0, collections: rootCollectionSummaries(root)};
  }

  const leaves = {};
  await Promise.all(
    [...touched].map(async (slug) => {
      leaves[slug] = await readJson(collectionObjectKey(slug));
    }),
  );

  const plan = planReconciliation({
    baseUrl,
    member: {
      manifestId: manifest.id,
      label: extractLabel(manifest.label),
      thumbnail: manifestThumbnail(manifest),
    },
    removed,
    desired: target,
    root,
    leaves,
  });
  const result = await applyReconciliation(plan);
  return {ok: true, ...result, collections: plan.collections};
}

// Never let projection maintenance fail a request whose authoritative write
// already succeeded — saying "failed" would be false in the direction that
// matters. Retrying the same request repairs it, and so does a reindex.
async function reconcileQuietly(args) {
  try {
    return await reconcileManifestCollections(args);
  } catch (error) {
    console.error("Collection reconcile failed", error);
    return {ok: false, error: error.message};
  }
}

// ---------------------------------------------------------------------------
// Public showcase
// ---------------------------------------------------------------------------

// A small, public sample of image services for the sign-in screen, which renders
// before anyone is authenticated and so cannot call the API at all.
//
// Written as a static object in the already-public IIIF bucket rather than
// exposed as an unauthenticated route: it keeps every API route behind Cognito
// and bounds what an anonymous visitor can see to this fixed sample, instead of
// handing them a way to enumerate the corpus. The images themselves are already
// publicly served by the Image API.
// Inside a space so the narrowed bucket policy still serves it anonymously —
// the sign-in screen renders before anyone can call the API. It samples the
// working corpus today; phase 7 moves both the key and the writer to
// published/, where a public pre-auth sample belongs.
const SHOWCASE_KEY = spaceKey(WORKING, "showcase.json");
const SHOWCASE_SIZE = 12;

function buildShowcase(summaries) {
  // One image per work — the first canvas, which is what the works list already
  // treats as a work's representative image.
  const candidates = summaries
    .map((summary) => summary.thumbnails?.[0])
    .filter((service) => typeof service === "string" && service);

  // Deterministic sample, so an unchanged corpus produces an unchanged file and
  // read-compare-write can skip the write entirely.
  const step = Math.max(1, Math.floor(candidates.length / SHOWCASE_SIZE));
  const picked = [];
  for (let i = 0; i < candidates.length && picked.length < SHOWCASE_SIZE; i += step) {
    picked.push(candidates[i]);
  }
  return {thumbnails: picked};
}

// Refreshed from GET /manifests: that route already reads every manifest, so
// this costs one small read and (usually) no write, and the sample stays current
// without any extra trigger to forget about.
async function refreshShowcase(summaries) {
  try {
    const next = buildShowcase(summaries);
    const current = await readJson(SHOWCASE_KEY);
    if (current && serializeCollection(current) === serializeCollection(next)) return;
    await writeJson(SHOWCASE_KEY, next);
  } catch (error) {
    // Decoration for a screen nobody has signed into yet; never fail the list.
    console.error("Showcase refresh failed", error);
  }
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function parseDesiredCollections(body) {
  const raw = body?.collections;
  if (!Array.isArray(raw)) {
    throw new CollectionNameError("collections must be an array");
  }
  if (raw.length > MAX_COLLECTIONS_PER_WORK) {
    throw new CollectionNameError('A work belongs to exactly one collection');
  }

  const bySlug = new Map();
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new CollectionNameError("Each collection must be a non-empty string");
    }
    // A slug, not a label. The client sends the collection's identity; it does
    // not send a name for the server to reduce into one.
    //
    // The label is filled in downstream by canonicalizeCollectionLabels, which
    // reads it off the root document — so a work can never cache a name the
    // collection does not actually have, and there is no spelling to forgive.
    const slug = sanitizeCollectionSlug(entry);
    if (!bySlug.has(slug)) bySlug.set(slug, {slug, label: null});
  }
  return [...bySlug.values()];
}

// The wire shape is singular — {collection: "campus-maps"} — because a work
// belongs to exactly one. The plural validator underneath is unchanged: a move
// still has to be reconciled against two collections, so the plumbing below
// this point keeps working in lists.
function parseDesiredCollection(body) {
  const raw = body?.collection;
  if (raw === null || raw === undefined || raw === '') {
    throw new CollectionNameError('A work must belong to a collection');
  }
  return parseDesiredCollections({collections: [raw]});
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// PUT /manifests/{id}/collection
async function handleManifestCollectionRoute({
  method,
  identifier,
  event,
  principal,
  readManifest,
  writeManifest,
}) {
  if (method !== "PUT") {
    return jsonResponse(405, {error: "Method not allowed"});
  }

  let desired;
  try {
    desired = parseDesiredCollection(parseBody(event));
  } catch (error) {
    if (error instanceof CollectionNameError || error.message === "Invalid JSON payload") {
      return jsonResponse(400, {error: error.message});
    }
    throw error;
  }

  try {
    // Independent reads, so they go together rather than in series.
    const [importStatus, manifest, root] = await Promise.all([
      readImportStatus(identifier).catch(() => null),
      readManifest(identifier),
      ensureRoot(),
    ]);

    // An import holds a stale copy of the manifest for minutes at a time and
    // writes it back wholesale, which would silently revert this edit.
    if (importStatus?.status === "in-progress") {
      return jsonResponse(409, {
        error: "This work is still importing — try again when it finishes",
      });
    }

    // Captured before the update: this is how the collections a work is LEAVING
    // stay in the reconciler's touched set.
    const previous = managedCollectionRefs(manifest?.partOf, {baseUrl});
    // Resolve names against the collections that already exist before writing,
    // so a work never caches a spelling its collection does not use.
    const canonical = canonicalizeCollectionLabels(desired, root);

    // Collections are instantiated on the Collections screen and nowhere else.
    // Without this, saving a work's Linking tab with an unrecognised name would
    // quietly create a collection as a side effect — which is exactly the
    // implicit instantiation this route is not allowed to do any more.
    const known = new Set(rootCollectionSummaries(root).map((entry) => entry.slug));
    const unknown = canonical.filter((entry) => !known.has(entry.slug));
    if (unknown.length) {
      return jsonResponse(400, {
        error: `No such collection: ${unknown.map((entry) => entry.label).join(", ")}. An administrator creates collections on the Collections screen.`,
      });
    }

    // Checked here rather than at the router, because this is the first point
    // where both ends of the move are known. Taking a work out of someone
    // else's collection and pushing one into someone else's are the same kind
    // of act, and an editor may do neither.
    if (!canMoveWork(principal, previous[0]?.slug || null, canonical[0]?.slug || null)) {
      return jsonResponse(403, {
        error: "You can only move works between collections you have been granted",
      });
    }

    const next = applyCollections(manifest, {baseUrl, collections: canonical});
    await writeManifest(identifier, next);

    const {collections, ...reconciliation} = await reconcileQuietly({
      manifest: next,
      desired: canonical,
      previous,
      root,
    });
    return jsonResponse(200, {
      // Deliberately NOT the whole manifest: a 271-canvas work serializes to
      // over a megabyte, and the only thing that changed is which collections
      // it belongs to. The client patches what it already holds.
      work: {
        identifier,
        collection: managedCollectionRefs(next.partOf, {baseUrl})[0] || null,
      },
      // The vocabulary comes back with the write, so the UI needs no follow-up
      // GET and can't race one against its own save.
      collections: collections || [],
      reconciliation,
    });
  } catch (error) {
    if (isNotFound(error)) {
      return jsonResponse(404, {error: "Manifest not found"});
    }
    console.error("Update collections failed", error);
    return jsonResponse(500, {error: "Unable to update collections"});
  }
}

// GET /collections, POST /collections/reindex
async function handleCollectionsRoute({method, segments, principal, event}) {
  // The publish endpoints live under the collection they act on.
  if (segments.length >= 3 && segments[2] === "publish") {
    return handlePublishRoute({method, segments, principal, event});
  }

  // The import endpoints. Two shapes: /collections/import[/preview], which acts
  // on no collection because it is about to create one, and
  // /collections/{slug}/import, which reports on a run.
  //
  // Matched here, ahead of everything that reads segments[1] as a slug — and
  // "import" is a reserved slug (sanitizeCollectionSlug), so the first shape can
  // never shadow a real collection.
  if (
    (segments.length >= 2 && segments[1] === "import") ||
    (segments.length === 3 && segments[2] === "import")
  ) {
    return handleCollectionImportRoute({method, segments, principal, event, ensureRoot});
  }

  // GET /collections/{slug}/works?q=&from=&size=
  //
  // Replaces GET /manifests and GET /search together. It is served by the
  // working index rather than by reading the collection document: at a few
  // thousand works that document is a multi-megabyte download with no
  // server-side search, sort or paging. The collection document stays the
  // authority on membership — it is what publish and repair read — and the
  // index is the read model the UI queries.
  if (segments.length === 3 && segments[2] === "works" && method === "GET") {
    const slug = decodeURIComponent(segments[1]);
    if (!canViewCollection(principal, slug)) {
      return jsonResponse(403, {error: "You do not have access to this collection"});
    }
    try {
      const params = event.queryStringParameters || {};
      const size = Math.min(Number(params.size) || 50, 200);
      const from = Math.max(Number(params.from) || 0, 0);
      const root = await ensureRoot();
      const known = rootCollectionSummaries(root).find((entry) => entry.slug === slug);
      if (!known) {
        return jsonResponse(404, {error: `No collection called "${slug}"`});
      }
      const [page, counts] = await Promise.all([
        listWorks({slug, q: params.q, from, size}),
        syncCounts(slug),
      ]);
      return jsonResponse(200, {
        // The label rides along so the page heading needs no second request.
        collection: {slug, label: known.label, id: known.id},
        ...page,
        from,
        size,
        // Counts for the whole collection, not the page: a publish summary
        // computed from the loaded rows would only be right on page one.
        counts,
      });
    } catch (error) {
      console.error("List collection works failed", error);
      return jsonResponse(500, {error: "Unable to list works"});
    }
  }

  if (segments.length === 1 && method === "GET") {
    try {
      // Exactly one GetObject — the whole point of keeping the root current.
      const root = await ensureRoot();
      return jsonResponse(200, {
        root: {id: root.id, label: extractLabel(root.label)},
        // Scoped to what the caller holds. The root itself is still named:
        // it always exists, its label is not a secret, and the UI shows it as
        // the parent row.
        collections: rootCollectionSummaries(root).filter((entry) =>
          canViewCollection(principal, entry.slug),
        ),
      });
    } catch (error) {
      console.error("List collections failed", error);
      return jsonResponse(500, {error: "Unable to list collections"});
    }
  }

  if (segments.length === 1 && method === "POST") {
    if (!canManageCollections(principal)) {
      return jsonResponse(403, {error: "Only an administrator can create a collection"});
    }
    try {
      const body = parseBody(event);
      // Two independent fields. The label is a display string in any script;
      // the slug is the permanent, public identifier, chosen once here and
      // changeable by no route afterwards. The UI prefills the slug from the
      // label as a convenience, but that derivation lives in the client on
      // purpose: the moment the server derives one from the other, the label
      // becomes identity again.
      const label = sanitizeCollectionLabel(body.label);
      const slug = sanitizeCollectionSlug(body.slug);
      const root = await ensureRoot();
      if (rootCollectionSummaries(root).some((entry) => entry.slug === slug)) {
        return jsonResponse(409, {error: `The id "${slug}" is already taken`});
      }
      // An empty IIIF Collection, not a placeholder: `items: []` is what the
      // spec allows and what makes this a real, resolvable document from the
      // moment it is created.
      const document = buildCollectionDocument({baseUrl, slug, label, members: []});
      await writeJson(collectionObjectKey(slug), document);

      const collections = [
        ...rootCollectionSummaries(root),
        {slug, label, thumbnail: null, itemCount: 0},
      ].sort((a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug));
      await writeJson(rootCollectionKey(), buildRootCollectionDocument({baseUrl, collections}));

      return jsonResponse(201, {collection: {slug, label, id: document.id, itemCount: 0, thumbnail: null}, collections});
    } catch (error) {
      if (error instanceof CollectionNameError || error.message === "Invalid JSON payload") {
        return jsonResponse(400, {error: error.message});
      }
      console.error("Create collection failed", error);
      return jsonResponse(500, {error: "Unable to create collection"});
    }
  }

  if (segments.length === 2 && segments[1] !== "reindex" && method === "DELETE") {
    if (!canManageCollections(principal)) {
      return jsonResponse(403, {error: "Only an administrator can delete a collection"});
    }
    const slug = decodeURIComponent(segments[1]);
    try {
      const root = await ensureRoot();
      const summary = rootCollectionSummaries(root).find((entry) => entry.slug === slug);
      if (!summary) {
        return jsonResponse(404, {error: "Collection not found"});
      }
      // Deliberately refuses a non-empty collection rather than cascading. A
      // cascade would rewrite every member manifest's partOf — a fan-out write
      // that is easy to trigger by accident and hard to undo. Emptying it first
      // is explicit and reversible.
      if (summary.itemCount) {
        return jsonResponse(409, {
          error: `"${summary.label}" still has ${summary.itemCount} work${summary.itemCount === 1 ? "" : "s"}. Remove them from it first.`,
        });
      }
      await s3.send(new DeleteObjectCommand({Bucket: bucket, Key: collectionObjectKey(slug)}));
      const collections = rootCollectionSummaries(root).filter((entry) => entry.slug !== slug);
      await writeJson(rootCollectionKey(), buildRootCollectionDocument({baseUrl, collections}));
      return jsonResponse(200, {deleted: true, collections});
    } catch (error) {
      console.error("Delete collection failed", error);
      return jsonResponse(500, {error: "Unable to delete collection"});
    }
  }

  if (segments.length === 2 && segments[1] === "reindex") {
    if (method !== "POST") {
      return jsonResponse(405, {error: "Method not allowed"});
    }
    // Rebuilds every collection document from the corpus, so it stays with
    // admins even though an editor can change an individual work's membership.
    if (!canReindex(principal)) {
      return jsonResponse(403, {error: "Only an administrator can rebuild the collection index"});
    }
    try {
      return jsonResponse(200, await reindexCollections());
    } catch (error) {
      console.error("Reindex collections failed", error);
      return jsonResponse(500, {error: error.message});
    }
  }

  if (segments.length === 1) {
    return jsonResponse(405, {error: "Method not allowed"});
  }

  return jsonResponse(404, {error: "Unknown endpoint"});
}

// Full rebuild, mirroring POST /search/reindex.
//
// MEMBERSHIP is still a pure function of the manifest corpus — that is what
// makes partial writes, hand-edits and base-URL changes repairable by one
// button. EXISTENCE is not: an admin-created collection can legitimately have
// no members, and nothing in the manifests records it. So this merges the
// corpus with the collections the root already declares, and prunes only what
// neither source knows about.
async function reindexCollections() {
  const startedAt = Date.now();
  // Repair rebuilds the working search index from the same pass. The index
  // holds no state S3 does not determine, which is what makes that possible —
  // and what stops it from ever being the authority.
  const indexDocs = [];
  const [summaries, root] = await Promise.all([
    listManifestSummaries({
      s3,
      bucket,
      onManifest: ({identifier, manifest}) => {
        indexDocs.push(
          workDocument(identifier, manifest, {
            // Re-serializing is faithful here: these bytes were written by the
            // same JSON.stringify(x, null, 2), and object key order survives a
            // parse/stringify round trip.
            bytes: JSON.stringify(manifest, null, 2),
          }),
        );
      },
    }),
    ensureRoot(),
  ]);
  const declared = new Map(rootCollectionSummaries(root).map((entry) => [entry.slug, entry.label]));

  // One pass. listManifestSummaries has already read every manifest, and the
  // summary carries partOf and thumbnail, so re-reading the corpus here would
  // double the IO of the most expensive endpoint in the app for nothing.
  const bySlug = new Map();
  for (const summary of summaries) {
    for (const ref of managedCollectionRefs(summary.partOf, {baseUrl})) {
      if (!bySlug.has(ref.slug)) bySlug.set(ref.slug, {labels: [], members: []});
      const group = bySlug.get(ref.slug);
      group.labels.push({identifier: summary.identifier, label: ref.label});
      group.members.push({
        manifestId: summary.manifestUrl,
        label: summary.label,
        thumbnail: summary.thumbnail,
      });
    }
  }

  // Declared-but-empty collections are real and must survive the rebuild. They
  // contribute no members, so they fall straight through to items: [].
  for (const slug of declared.keys()) {
    if (!bySlug.has(slug)) bySlug.set(slug, {labels: [], members: []});
  }

  const collections = [];
  const documents = [];
  for (const [slug, group] of bySlug) {
    // Deterministic canonical label: the earliest member by identifier names it.
    const [canonical] = [...group.labels].sort((a, b) => a.identifier.localeCompare(b.identifier));
    const distinct = new Set(group.labels.map((entry) => entry.label));
    if (distinct.size > 1) {
      console.warn(`Collection ${slug} has conflicting labels: ${[...distinct].join(" | ")}`);
    }
    const label = canonical?.label || declared.get(slug) || slug;
    const members = [...group.members].sort(
      (a, b) => a.label.localeCompare(b.label) || a.manifestId.localeCompare(b.manifestId),
    );

    const document = buildCollectionDocument({baseUrl, slug, label, members});
    documents.push({slug, document});
    collections.push({
      slug,
      label,
      thumbnail: document.thumbnail || null,
      itemCount: members.length,
    });
  }

  await Promise.all(documents.map(({slug, document}) => writeJson(collectionObjectKey(slug), document)));
  const written = documents.length;

  collections.sort((a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug));
  await writeJson(rootCollectionKey(), buildRootCollectionDocument({baseUrl, collections}));

  const deleted = await pruneCollections(new Set(bySlug.keys()));
  const index = await rebuildWorkIndex(indexDocs);
  // The public sign-in sample used to ride on GET /manifests, which is gone.
  // This pass has already paid for the corpus read, so it lands here until
  // the publish run takes it over and builds it from published works instead.
  await refreshShowcase(summaries);

  return {
    collections: collections.length,
    manifests: summaries.length,
    written,
    deleted,
    index,
    tookMs: Date.now() - startedAt,
  };
}

async function pruneCollections(keep) {
  let deleted = 0;
  let continuationToken;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${spaceKey(WORKING, COLLECTION_PREFIX)}/`,
        ContinuationToken: continuationToken,
      }),
    );
    const stale = (response.Contents || [])
      .filter((object) => object.Key.endsWith(`/${COLLECTION_OBJECT}`))
      .map((object) => ({key: object.Key, slug: object.Key.split("/")[2]}))
      // The root is never pruned, however empty it gets.
      .filter(({slug}) => slug && slug !== ROOT_COLLECTION_SLUG && !keep.has(slug));

    for (const {key} of stale) {
      await s3.send(new DeleteObjectCommand({Bucket: bucket, Key: key}));
      deleted += 1;
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return deleted;
}

// Files a freshly created work into collections. Shared by the create and the
// import route so both apply membership the same way; `previous` is empty by
// construction, since the work did not exist a moment ago.
async function fileNewWork({identifier, manifest, slug, writeManifest, waitForIndex = true}) {
  const desired = parseDesiredCollections({collections: slug ? [slug] : []});
  if (!desired.length) return manifest;
  const root = await ensureRoot();
  const canonical = canonicalizeCollectionLabels(desired, root);
  const next = applyCollections(manifest, {baseUrl, collections: canonical});
  await writeManifest(identifier, next, {waitForIndex});
  await reconcileQuietly({manifest: next, desired: canonical, previous: [], root});
  return next;
}

// The slugs a create request is asking for, so the permission check can run
// before anything is written. Takes a slug, not a label — see
// parseDesiredCollections.
function desiredCollectionSlugs(slug) {
  return parseDesiredCollections({collections: slug ? [slug] : []}).map((entry) => entry.slug);
}

module.exports = {
  fileNewWork,
  desiredCollectionSlugs,
  refreshShowcase,
  applyReconciliation,
  reconcileManifestCollections,
  reconcileQuietly,
  parseDesiredCollections,
  parseDesiredCollection,
  handleCollectionsRoute,
  handleManifestCollectionRoute,
  reindexCollections,
  ensureRoot,
  readRoot,
};
