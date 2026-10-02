// Reading and writing a manifest object.
//
// Extracted so index.js and importAssets.js share ONE writer. They cannot
// require each other — index.js requires importAssets.js — and the private copy
// importAssets.js used to keep is exactly how a write path ends up updating S3
// and silently skipping the read model. Same reason http.js exists.

const {S3Client, PutObjectCommand} = require("@aws-sdk/client-s3");
const {manifestObjectKey, readManifest: readManifestShared} = require("../../../shared/manifest");
const {normalizeContext} = require("../../../shared/collection");
const {contentHash} = require("../../../shared/publish");
const {reconcileQuietly} = require("./collectionStore");

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;

async function readManifest(identifier) {
  return readManifestShared({s3, bucket, identifier});
}

// Every write refreshes the work's entry in its collection document — label,
// thumbnails, canvas count and the content hash the works list compares — in
// the same request, so the list shows the save on its very next read.
//
// `skipCollection` is for a write a later one supersedes:
//   - the import walk, which rewrites the manifest once per canvas and
//     refreshes the entry once at the end, rather than 271 times;
//   - a write that changes MEMBERSHIP, whose caller reconciles itself with the
//     returned hash, because only it knows the collections being left
//     (`previous`). Reconciling here first would do the same work twice.
//   - the collection import, which must never touch the collection document per
//     work; its WriteCollection builds the document once, from the results.
//
// Returns the hash of the bytes actually written, never of a re-serialization.
async function writeManifest(identifier, manifest, {skipCollection = false} = {}) {
  const key = manifestObjectKey(identifier);
  // Normalized on EVERY write, not just the ones that touch partOf, so whatever
  // route wrote it — a title edit, a metadata edit, an asset reorder — a stored
  // manifest's @context ends with the presentation context, exactly once.
  const next = {...manifest, "@context": normalizeContext(manifest?.["@context"])};
  const body = JSON.stringify(next, null, 2);
  await s3.send(
    new PutObjectCommand({Bucket: bucket, Key: key, Body: body, ContentType: "application/json"}),
  );
  const hash = contentHash(body);
  if (!skipCollection) {
    // Quietly: the manifest is the truth and it has already landed, so failing
    // the save because a projection lagged would report failure in the wrong
    // direction. The next save, or POST /collections/reindex, repairs it.
    await reconcileQuietly({manifest: next, contentHash: hash});
  }
  return {key, contentHash: hash, manifest: next};
}

module.exports = {readManifest, writeManifest};
