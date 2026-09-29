// Audio/video transcoding. One function, two triggers:
//
//   S3 ObjectCreated under {source}/av/  -> submit a MediaConvert job
//   MediaConvert Job State Change        -> record the outcome in media.json
//
// media.json is the whole interface to the UI, the same way info.json is for an
// image: the dropzone polls it through IIIFDistribution until it says ready or
// error. It is written "processing" BEFORE the job is submitted, so no
// completion event can ever land ahead of it and be overwritten.
//
// It is also what GET /manifests/{id}/media reads to recover an upload whose
// page was left (mediaRoutes.js), which is why it carries the original
// filename: the source key is a random id, and nothing else remembers it.

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const {MediaConvertClient, CreateJobCommand} = require("@aws-sdk/client-mediaconvert");
const {
  parseSourceKey,
  outputPrefix,
  mediaStatusKey,
  buildJobSettings,
  summarizeCompletedJob,
} = require("../../../shared/av");

const s3 = new S3Client({});
// MediaConvert no longer needs the account-specific endpoint from
// DescribeEndpoints; the regional one the SDK resolves by default is enough.
const mediaConvert = new MediaConvertClient({});

const IIIF_BUCKET = process.env.IIIF_BUCKET;
const SOURCE_BUCKET = process.env.SOURCE_BUCKET;
const IIIF_BASE_URL = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");
const MEDIACONVERT_ROLE_ARN = process.env.MEDIACONVERT_ROLE_ARN;
// Every personal stack shares the account's default event bus, so each job is
// tagged with its stack and the EventBridge rule matches only its own.
const STACK_NAME = process.env.STACK_NAME;

async function writeStatus(workId, assetId, body) {
  await s3.send(
    new PutObjectCommand({
      Bucket: IIIF_BUCKET,
      Key: mediaStatusKey(workId, assetId),
      Body: JSON.stringify({...body, updatedAt: new Date().toISOString()}),
      ContentType: "application/json",
      // CachingOptimized honours this down to its 1s MinTTL, so a poll sees a
      // status change within a second instead of a day.
      CacheControl: "no-cache",
    }),
  );
}

function isNotFound(error) {
  return error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey" || error?.name === "NotFound";
}

async function readStatus(workId, assetId) {
  try {
    const response = await s3.send(new GetObjectCommand({Bucket: IIIF_BUCKET, Key: mediaStatusKey(workId, assetId)}));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// The UI sends the original name as x-amz-meta-filename, URI-encoded because
// a header value must be ASCII. Best effort: a missing or mangled one only
// costs a recovered item its label.
async function sourceFilename(bucket, key) {
  try {
    const {Metadata} = await s3.send(new HeadObjectCommand({Bucket: bucket, Key: key}));
    return Metadata?.filename ? decodeURIComponent(Metadata.filename) : null;
  } catch (error) {
    console.warn(`Could not read filename for ${key}`, error.message);
    return null;
  }
}

async function sourceExists(key) {
  try {
    await s3.send(new HeadObjectCommand({Bucket: SOURCE_BUCKET, Key: key}));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

// An asset discarded while its job was still running: DELETE
// /manifests/{id}/media/{assetId} removed what existed then, and MediaConvert
// has since written the rest. Nothing will ever reference it, so it goes now.
async function deleteOutputs(workId, assetId) {
  const prefix = `${outputPrefix(workId, assetId)}/`;
  let token;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({Bucket: IIIF_BUCKET, Prefix: prefix, ContinuationToken: token}),
    );
    const keys = (response.Contents || []).map((object) => ({Key: object.Key}));
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({Bucket: IIIF_BUCKET, Delete: {Objects: keys}}));
    }
    token = response.NextContinuationToken;
  } while (token);
}

async function handleUpload(record) {
  const sourceBucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
  const parsed = parseSourceKey(key);
  if (!parsed) {
    console.log(`Skipping ${key} (not an av/{workId}/{assetId}.{ext} upload)`);
    return;
  }
  const {workId, assetId, kind} = parsed;
  const filename = await sourceFilename(sourceBucket, key);
  if (!kind) {
    await writeStatus(workId, assetId, {status: "error", filename, error: `Unsupported file type: .${parsed.ext}`});
    return;
  }

  await writeStatus(workId, assetId, {status: "processing", kind, filename});
  try {
    const {Job} = await mediaConvert.send(
      new CreateJobCommand({
        Role: MEDIACONVERT_ROLE_ARN,
        UserMetadata: {stack: STACK_NAME, workId, assetId, kind, sourceKey: key},
        Settings: buildJobSettings({
          kind,
          inputUri: `s3://${sourceBucket}/${key}`,
          destination: `s3://${IIIF_BUCKET}/${outputPrefix(workId, assetId)}`,
        }),
      }),
    );
    console.log(`Submitted MediaConvert job ${Job?.Id} for ${key}`);
  } catch (error) {
    // Not rethrown: S3's async retries would resubmit into the same failure,
    // and the UI is better served by the reason than by a retry.
    console.error(`CreateJob failed for ${key}`, error);
    await writeStatus(workId, assetId, {
      status: "error",
      kind,
      filename,
      error: error.message || "Could not start transcoding",
    });
  }
}

async function handleJobEvent(detail) {
  const {workId, assetId, kind, sourceKey} = detail?.userMetadata || {};
  if (!workId || !assetId) {
    console.log("Ignoring job event with no asset metadata", detail?.jobId);
    return;
  }
  // Jobs submitted before sourceKey was recorded skip this check; they cannot
  // have been discarded through a route that did not exist yet.
  if (sourceKey && !(await sourceExists(sourceKey))) {
    console.log(`Source ${sourceKey} was discarded while job ${detail.jobId} ran; removing its outputs`);
    await deleteOutputs(workId, assetId);
    return;
  }
  // The completion replaces the whole status object, so anything recorded at
  // submit time that the event does not carry has to be brought forward.
  const {filename = null} = (await readStatus(workId, assetId)) || {};
  if (detail.status === "ERROR") {
    console.error(`MediaConvert job ${detail.jobId} failed`, detail.errorCode, detail.errorMessage);
    await writeStatus(workId, assetId, {
      status: "error",
      kind,
      filename,
      error: detail.errorMessage || `Transcoding failed (${detail.errorCode || "unknown error"})`,
    });
    return;
  }
  if (detail.status !== "COMPLETE") return;
  try {
    const summary = summarizeCompletedJob(detail, {kind, bucket: IIIF_BUCKET, baseUrl: IIIF_BASE_URL});
    await writeStatus(workId, assetId, {...summary, filename, jobId: detail.jobId});
    console.log(`Ready: ${summary.streamUrl}`);
  } catch (error) {
    console.error(`Could not summarize job ${detail.jobId}`, error, JSON.stringify(detail));
    await writeStatus(workId, assetId, {status: "error", kind, filename, error: error.message});
  }
}

exports.handler = async (event) => {
  if (event?.source === "aws.mediaconvert") {
    return handleJobEvent(event.detail);
  }
  for (const record of event?.Records || []) {
    await handleUpload(record);
  }
};
