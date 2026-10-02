// The working collection documents: reading them together with their version,
// and writing them so that two requests touching the same document cannot lose
// each other's update.
//
// Extracted from collections.js so store.js can keep a collection current on
// every save. store.js cannot require collections.js — collections.js requires
// importAssets.js, which requires store.js — so the IO both need lives here,
// and this module requires neither.
//
// Every save rewrites its collection's leaf now, because the leaf carries each
// member's content hash (it is what the works list reads). That makes the leaf
// a read-modify-write on every edit, and two curators saving different works in
// one collection would otherwise race: both read the same leaf, and whichever
// writes second silently drops the other's change. So the read records the
// object's ETag, the write is conditional on it (IfMatch, or IfNoneMatch for a
// document that did not exist), and a lost race re-reads, re-plans and tries
// again. The root is written the same way — it is the register of which
// collections exist, and losing an entry there would lose a collection.
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const {
  collectionObjectKey,
  rootCollectionKey,
  createRootCollectionTemplate,
  managedCollectionRefs,
  memberFromManifest,
  rootCollectionSummaries,
  serializeCollection,
  planReconciliation,
} = require("../../../shared/collection");
const {isNotFound} = require("./http");

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;
const baseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");

// Enough to ride out a burst of saves to one collection; past that something is
// wrong and the caller's "quietly" wrapper logs it. A reindex repairs whatever
// was left behind.
const WRITE_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamToString(body) {
  if (typeof body === "string") return body;
  if (body && typeof body.transformToString === "function") return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// {document, etag}, or null when there is no such object.
async function readVersioned(key) {
  try {
    const response = await s3.send(new GetObjectCommand({Bucket: bucket, Key: key}));
    return {document: JSON.parse(await streamToString(response.Body)), etag: response.ETag};
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readJson(key) {
  return (await readVersioned(key))?.document ?? null;
}

// Unconditional. For a document only one writer ever produces, or one being
// rebuilt wholesale by a repair.
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

// Lands only if the object is still the version that was read: `etag` from
// readVersioned, or null for "must not exist yet".
async function writeVersioned(key, document, etag) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: serializeCollection(document),
      ContentType: "application/json",
      ...(etag ? {IfMatch: etag} : {IfNoneMatch: "*"}),
    }),
  );
}

// 412: the object changed since it was read. 409: S3 refused a conditional
// write racing another one in flight on the same key. Both mean "someone else
// wrote first", and both are answered by reading again.
function isWriteConflict(error) {
  const status = error?.$metadata?.httpStatusCode;
  return (
    status === 412 ||
    status === 409 ||
    error?.name === "PreconditionFailed" ||
    error?.name === "ConditionalRequestConflict"
  );
}

// Runs `attempt` — which must read, decide and write afresh each time — until
// it lands without a conflict. Jittered, so two losers do not collide again.
async function withWriteRetry(attempt) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isWriteConflict(error) || tries >= WRITE_ATTEMPTS) throw error;
      await sleep(25 * tries + Math.floor(Math.random() * 50));
    }
  }
}

async function readRoot() {
  return readJson(rootCollectionKey());
}

// The root must be materialized, not synthesized on read: it is publicly
// dereferenceable and a downstream consumer must not get a 404. IfNoneMatch
// makes this a true create-if-absent, so two racing requests can't fight.
async function ensureRootVersioned() {
  const existing = await readVersioned(rootCollectionKey());
  if (existing) return existing;
  try {
    await writeVersioned(rootCollectionKey(), createRootCollectionTemplate({baseUrl}), null);
  } catch (error) {
    // Someone else created it between our read and our write. Theirs is fine.
    if (!isWriteConflict(error)) throw error;
  }
  return readVersioned(rootCollectionKey());
}

async function ensureRoot() {
  return (await ensureRootVersioned()).document;
}

// Rewrite the root as a function of its current contents. `change` sees the
// root as it is NOW — re-read on every attempt — and returns the next document,
// or null to leave it alone. It may throw to refuse (a slug already taken, say),
// and that refusal is re-checked against fresh contents if a write was lost.
async function updateRoot(change) {
  return withWriteRetry(async () => {
    const {document, etag} = await ensureRootVersioned();
    const next = change(document);
    if (!next || serializeCollection(next) === serializeCollection(document)) return document;
    await writeVersioned(rootCollectionKey(), next, etag);
    return next;
  });
}

// Bring the projection in line with one manifest.
//
//   desired === null  -> membership unchanged; refresh this work's member entry
//   desired === []    -> remove from everything (used by the delete path)
//   removed           -> the manifest itself is gone
//   contentHash       -> the hash of the bytes just stored, which only the
//                        writer knows. Without it the member records none and
//                        reads as "changed" — the safe direction.
//
// Order matters: every touched leaf, then the root, then the deletions. That
// keeps `root ⊆ existing leaf documents` true at every intermediate state, so a
// crash can never leave the root advertising a collection that 404s. A lost race
// on any one write re-reads everything and re-plans; leaves already written by
// the earlier attempt then plan as no-ops, so a retry costs reads, not writes.
async function reconcileManifestCollections({
  manifest,
  contentHash,
  desired = null,
  previous,
  removed = false,
}) {
  // `previous` must describe the membership as it was BEFORE the manifest was
  // updated. Deriving it from an already-updated manifest silently drops every
  // removal out of the touched set, leaving the abandoned collection behind
  // until the next reindex.
  const current = previous || managedCollectionRefs(manifest?.partOf, {baseUrl});
  const target = desired === null ? current : desired;
  // The UNION, never the diff: a diff would short-circuit a retry after a
  // partial failure and leave the projection broken until the next reindex.
  const touched = [...new Set([...current, ...target].map((ref) => ref.slug))].sort();
  const member = memberFromManifest(manifest, {contentHash});

  return withWriteRetry(async () => {
    const [root, ...leafReads] = await Promise.all([
      ensureRootVersioned(),
      ...touched.map((slug) => readVersioned(collectionObjectKey(slug))),
    ]);
    if (!touched.length) {
      return {ok: true, written: 0, deleted: 0, collections: rootCollectionSummaries(root.document)};
    }
    const leaves = {};
    const etags = {};
    touched.forEach((slug, i) => {
      leaves[slug] = leafReads[i]?.document || null;
      etags[slug] = leafReads[i]?.etag || null;
    });

    const plan = planReconciliation({baseUrl, member, removed, desired: target, root: root.document, leaves});
    // Within a phase the objects are independent, so they go in parallel.
    await Promise.all(plan.leafWrites.map((write) => writeVersioned(write.key, write.document, etags[write.slug])));
    if (plan.rootChanged) {
      await writeVersioned(rootCollectionKey(), plan.rootNext, root.etag);
    }
    await Promise.all(
      plan.leafDeletes.map((removal) => s3.send(new DeleteObjectCommand({Bucket: bucket, Key: removal.key}))),
    );
    return {ok: true, written: plan.leafWrites.length, deleted: plan.leafDeletes.length, collections: plan.collections};
  });
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

module.exports = {
  s3,
  bucket,
  readVersioned,
  readJson,
  writeJson,
  writeVersioned,
  isWriteConflict,
  withWriteRetry,
  readRoot,
  ensureRoot,
  updateRoot,
  reconcileManifestCollections,
  reconcileQuietly,
};
