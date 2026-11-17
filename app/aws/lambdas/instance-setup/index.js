// The InstanceSetup custom resource (template.yml): everything a deploy does
// that CloudFormation has no resource for.
//
// On every create and update:
//   1. copy the admin UI (UiLayer, at /opt/understory-ui) into UiBucket;
//   2. copy the instance's branding folder (BrandingLayer, the rest of /opt)
//      to branding/ in UiBucket;
//   3. write /config.json, the settings the UI reads at run time;
//   4. delete whatever else is in the bucket;
//   5. invalidate the admin distribution;
//   6. invite AdminEmail as an administrator, if no such user exists yet.
//
// On delete it empties UiBucket, so CloudFormation can delete the bucket. It
// never deletes a user.
//
// What goes where is decided in app/shared/instanceSetup.js, which is tested.
// This file only moves bytes.

const {readFile, readdir} = require("node:fs/promises");
const {join, relative} = require("node:path");
const https = require("node:https");
const {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const {CloudFrontClient, CreateInvalidationCommand} = require("@aws-sdk/client-cloudfront");
const {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} = require("@aws-sdk/client-cognito-identity-provider");

const {
  CONFIG_KEY,
  brandingKey,
  buildConfigDocument,
  cacheControlFor,
  contentTypeFor,
  staleKeys,
  uiKey,
} = require("../../../shared/instanceSetup");

const LAYERS_ROOT = "/opt";
const UI_ROOT = join(LAYERS_ROOT, "understory-ui");
const UPLOAD_CONCURRENCY = 16;

const s3 = new S3Client({});
const cloudfront = new CloudFrontClient({});
const cognito = new CognitoIdentityProviderClient({});

async function walk(root) {
  const files = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files;
}

async function inPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function listKeys(bucket) {
  const keys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({Bucket: bucket, ContinuationToken: token}));
    for (const object of page.Contents || []) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteKeys(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({Bucket: bucket, Delete: {Objects: batch.map((Key) => ({Key})), Quiet: true}}),
    );
  }
}

async function putObject(bucket, key, body) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentTypeFor(key),
      CacheControl: cacheControlFor(key),
    }),
  );
}

// [{path, key}] for every file under root that keyFor accepts.
async function filesFrom(root, keyFor) {
  const files = [];
  for (const path of await walk(root)) {
    const key = keyFor(relative(root, path).split("\\").join("/"));
    if (key) files.push({path, key});
  }
  return files;
}

async function syncBucket(props) {
  const bucket = props.UiBucket;
  const uiFiles = await filesFrom(UI_ROOT, uiKey);
  if (!uiFiles.some((file) => file.key === "index.html")) {
    // A stack built without the UI (scripts/build.sh not run, or a broken
    // release) would otherwise deploy an admin site with nothing in it.
    throw new Error(`No admin UI in UiLayer (${UI_ROOT}/index.html is missing). Build it with scripts/build.sh.`);
  }
  const brandingFiles = await filesFrom(LAYERS_ROOT, brandingKey);

  const existing = await listKeys(bucket);
  const files = [...uiFiles, ...brandingFiles];
  await inPool(files, UPLOAD_CONCURRENCY, async ({path, key}) => {
    await putObject(bucket, key, await readFile(path));
  });

  const config = buildConfigDocument(props.Config || {}, brandingFiles.map((file) => file.key));
  await putObject(bucket, CONFIG_KEY, `${JSON.stringify(config, null, 2)}\n`);

  const written = [...files.map((file) => file.key), CONFIG_KEY];
  // After the uploads, so no page is ever missing mid-deploy.
  await deleteKeys(bucket, staleKeys(existing, written));
  return {uiFiles: uiFiles.length, brandingFiles: brandingFiles.length};
}

// One path, whatever changed: a wildcard is a single invalidation path.
async function invalidate(distributionId, reference) {
  await cloudfront.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {CallerReference: reference, Paths: {Quantity: 1, Items: ["/*"]}},
    }),
  );
}

// Invites the address as an administrator unless a user with it already
// exists, in which case nothing is touched: an admin may have demoted them on
// purpose. Cognito emails the temporary password (InviteMessageTemplate).
async function ensureAdmin(userPoolId, email) {
  const address = (email || "").trim().toLowerCase();
  if (!address) return "none";
  try {
    await cognito.send(new AdminGetUserCommand({UserPoolId: userPoolId, Username: address}));
    return "exists";
  } catch (error) {
    if (error?.name !== "UserNotFoundException") throw error;
  }
  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: address,
      UserAttributes: [
        {Name: "email", Value: address},
        {Name: "email_verified", Value: "true"},
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    }),
  );
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      // The pool's own username (a UUID under UsernameAttributes: [email]).
      Username: created.User.Username,
      GroupName: "admin",
    }),
  );
  return "invited";
}

async function emptyBucket(bucket) {
  try {
    await deleteKeys(bucket, await listKeys(bucket));
  } catch (error) {
    // Already gone, or never created: nothing to empty.
    if (error?.name !== "NoSuchBucket") throw error;
  }
}

function respond(event, context, status, reason, data) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason ? `${reason} (log stream ${context.logStreamName})` : `See ${context.logStreamName}`,
    // Stable, so an update is never mistaken for a replacement: a replacement
    // would be followed by a Delete of the old id, which empties the bucket.
    PhysicalResourceId: event.PhysicalResourceId || `${event.ResourceProperties.UiBucket}-setup`,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data || {},
  });
  return new Promise((resolve) => {
    const request = https.request(
      event.ResponseURL,
      {method: "PUT", headers: {"Content-Type": "", "Content-Length": Buffer.byteLength(body)}},
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    );
    request.on("error", (error) => {
      console.error("Could not send the response to CloudFormation", error);
      resolve();
    });
    request.end(body);
  });
}

exports.handler = async (event, context) => {
  // The pre-signed ResponseURL and the admin's address stay out of the logs.
  const {AdminEmail, ...logged} = event.ResourceProperties || {};
  console.log(JSON.stringify({
    ...event,
    ResponseURL: "(omitted)",
    ResourceProperties: {...logged, AdminEmail: AdminEmail ? "(set)" : ""},
  }));
  let answered = false;
  const answer = async (...args) => {
    if (answered) return;
    answered = true;
    await respond(event, context, ...args);
  };
  // CloudFormation waits for an answer whatever happens here, so a timeout
  // must still produce one: send FAILED shortly before Lambda would kill us.
  const deadline = setTimeout(
    () => answer("FAILED", "Timed out before finishing"),
    Math.max(context.getRemainingTimeInMillis() - 15000, 1000),
  );

  try {
    const props = event.ResourceProperties;
    if (event.RequestType === "Delete") {
      await emptyBucket(props.UiBucket);
      await answer("SUCCESS");
      return;
    }
    const synced = await syncBucket(props);
    await invalidate(props.DistributionId, event.RequestId);
    const admin = await ensureAdmin(props.UserPoolId, props.AdminEmail);
    console.log(JSON.stringify({...synced, admin}));
    await answer("SUCCESS", null, {Admin: admin});
  } catch (error) {
    console.error(error);
    await answer("FAILED", error.message || String(error));
  } finally {
    clearTimeout(deadline);
  }
};
