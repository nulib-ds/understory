// Reading and writing a manifest object.
//
// Extracted so index.js and importAssets.js share ONE writer. They cannot
// require each other — index.js requires importAssets.js — and the private copy
// importAssets.js used to keep is exactly how a write path ends up updating S3
// and silently skipping the search index. Same reason http.js exists.

const {S3Client, PutObjectCommand} = require("@aws-sdk/client-s3");
const {manifestObjectKey, readManifest: readManifestShared} = require("../../../shared/manifest");
const {upsertQuietly, SYNC_CHANGED} = require("./workIndex");
const {normalizeContext} = require("../../../shared/collection");

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;

async function readManifest(identifier) {
  return readManifestShared({s3, bucket, identifier});
}

// `skipIndex` is for the import walk, which rewrites the manifest once per
// canvas: a 271-canvas import would otherwise be 271 index writes. The import
// indexes once when it starts and once when it finishes.
// `waitForIndex: false` indexes without waiting for the refresh. Only for a
// write that a later one in the same request supersedes — see the import route.
async function writeManifest(identifier, manifest, {skipIndex = false, syncState, waitForIndex = true} = {}) {
  const key = manifestObjectKey(identifier);
  // Normalized on EVERY write, not just the ones that touch partOf, so whatever
  // route wrote it — a title edit, a metadata edit, an asset reorder — a stored
  // manifest's @context ends with the presentation context, exactly once.
  const next = {...manifest, "@context": normalizeContext(manifest?.["@context"])};
  const body = JSON.stringify(next, null, 2);
  await s3.send(
    new PutObjectCommand({Bucket: bucket, Key: key, Body: body, ContentType: "application/json"}),
  );
  if (!skipIndex) {
    // Hash the bytes actually written, so "changed since it was published?"
    // compares like with like.
    await upsertQuietly(identifier, next, {
      bytes: body,
      syncState: syncState || SYNC_CHANGED,
      waitFor: waitForIndex,
    });
  }
  return key;
}

module.exports = {readManifest, writeManifest};
