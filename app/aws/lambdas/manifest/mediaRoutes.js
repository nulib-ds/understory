// Unattached audio/video for one work: the recovery half of the upload flow.
//
//   GET    /manifests/{id}/media            uploads not yet on a canvas
//   DELETE /manifests/{id}/media/{assetId}  discard one, source and renditions
//
// Nothing here is stored — see unattachedMedia in app/shared/av.js. The
// source listing, each asset's media.json and the manifest together already
// say everything the dropzone lost when the page was left.
//
// Both are edit routes. An unattached upload is only useful to someone who can
// attach it, and discarding one is a delete.

const {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const {jsonResponse, isNotFound} = require("./http");
const {
  AV_PREFIX,
  mediaStatusKey,
  outputPrefix,
  parseSourceKey,
  attachedAssetIds,
  unattachedMedia,
  isAssetId,
} = require("../../../shared/av");

const s3 = new S3Client({});
const iiifBucket = process.env.IIIF_BUCKET;
const sourceBucket = process.env.SOURCE_BUCKET;

async function listObjects(bucket, prefix) {
  const objects = [];
  let token;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({Bucket: bucket, Prefix: prefix, ContinuationToken: token}),
    );
    for (const item of response.Contents || []) {
      objects.push({key: item.Key, lastModified: item.LastModified});
    }
    token = response.NextContinuationToken;
  } while (token);
  return objects;
}

async function deleteObjects(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 0) continue;
    await s3.send(
      new DeleteObjectsCommand({Bucket: bucket, Delete: {Objects: batch.map((Key) => ({Key}))}}),
    );
  }
}

async function readStatus(workId, assetId) {
  try {
    const response = await s3.send(
      new GetObjectCommand({Bucket: iiifBucket, Key: mediaStatusKey(workId, assetId)}),
    );
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function listUnattached(identifier, manifest) {
  // ListObjectsV2 only returns COMPLETED objects, so an upload abandoned
  // halfway is invisible here — which is right: it never reached MediaConvert.
  const uploads = (await listObjects(sourceBucket, `${AV_PREFIX}/${identifier}/`)).filter(
    (upload) => parseSourceKey(upload.key)?.workId === identifier,
  );
  const attached = attachedAssetIds(manifest, identifier);
  const statuses = new Map();
  await Promise.all(
    uploads.map(async (upload) => {
      const {assetId} = parseSourceKey(upload.key);
      if (attached.has(assetId)) return; // not returned, so not worth a read
      const status = await readStatus(identifier, assetId);
      if (status) statuses.set(assetId, status);
    }),
  );
  return unattachedMedia({uploads, workId: identifier, manifest, statuses});
}

// A job still running when its asset is discarded keeps writing renditions for
// a moment afterwards; the av-transcode Lambda sees the source is gone when the
// job completes and removes them then.
async function discard(identifier, assetId) {
  const sourceKeys = (await listObjects(sourceBucket, `${AV_PREFIX}/${identifier}/${assetId}.`)).map(
    (object) => object.key,
  );
  const outputKeys = (await listObjects(iiifBucket, `${outputPrefix(identifier, assetId)}/`)).map(
    (object) => object.key,
  );
  await Promise.all([deleteObjects(sourceBucket, sourceKeys), deleteObjects(iiifBucket, outputKeys)]);
  return {sourceKeys: sourceKeys.length, outputKeys: outputKeys.length};
}

async function handleMediaRoute({method, identifier, assetId, principal, readManifest, canEdit}) {
  let manifest;
  try {
    manifest = await readManifest(identifier);
  } catch (error) {
    if (isNotFound(error)) return jsonResponse(404, {error: "Manifest not found"});
    console.error("Read manifest for media failed", error);
    return jsonResponse(500, {error: "Unable to load media"});
  }
  if (!canEdit(principal, manifest)) {
    return jsonResponse(403, {error: "You can only change works in a collection you have been granted"});
  }

  if (assetId === undefined) {
    if (method !== "GET") return jsonResponse(405, {error: "Method not allowed"});
    try {
      return jsonResponse(200, {media: await listUnattached(identifier, manifest)});
    } catch (error) {
      console.error("List unattached media failed", error);
      return jsonResponse(500, {error: "Unable to load media"});
    }
  }

  if (method !== "DELETE") return jsonResponse(405, {error: "Method not allowed"});
  if (!isAssetId(assetId)) return jsonResponse(400, {error: "Invalid asset id"});
  // Discarding something a canvas plays would leave that canvas silently
  // broken; the canvas has to be removed first.
  if (attachedAssetIds(manifest, identifier).has(assetId)) {
    return jsonResponse(409, {error: "This media is on a canvas — remove the canvas first"});
  }
  try {
    const removed = await discard(identifier, assetId);
    return jsonResponse(200, {discarded: true, ...removed});
  } catch (error) {
    console.error("Discard media failed", error);
    return jsonResponse(500, {error: "Unable to discard media"});
  }
}

module.exports = {handleMediaRoute};
