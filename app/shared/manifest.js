const {GetObjectCommand, ListObjectsV2Command} = require("@aws-sdk/client-s3");
// Re-exported below so existing importers keep working.
const {extractLabel} = require("./language");
// One-way: collection.js depends on nothing but ./language, so requiring it
// here is safe and keeps a single definition of the thumbnail rule.
const {manifestThumbnail} = require("./collection");
const {WORKING, spaceKey, spaceBase} = require("./space");

const MANIFEST_PREFIX = "presentation/manifest";
const MANIFEST_OBJECT = "manifest.json";
const manifestIdPattern = /^[A-Za-z0-9._-]+$/;

function sanitizeManifestIdentifier(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    throw new Error("Manifest id is required");
  }
  if (!manifestIdPattern.test(trimmed)) {
    throw new Error(
      "Manifest id may only include letters, numbers, periods, underscores, or dashes",
    );
  }
  if (trimmed.includes("..")) {
    throw new Error("Manifest id cannot contain parent directory references");
  }
  return trimmed;
}

// Space-qualified, defaulting to working: every caller but the publish
// pipeline wants the draft, so the default keeps them correct without
// threading an argument through twenty call sites.
function manifestObjectKey(identifier, space = WORKING) {
  const normalized = sanitizeManifestIdentifier(identifier);
  return spaceKey(space, `${MANIFEST_PREFIX}/${normalized}/${MANIFEST_OBJECT}`);
}

function buildManifestId(baseUrl, identifier, space = WORKING) {
  const normalizedBase = (baseUrl || "").replace(/\/$/, "");
  const manifestKey = manifestObjectKey(identifier, space);
  return normalizedBase ? `${normalizedBase}/${manifestKey}` : manifestKey;
}

function createManifestTemplate({baseUrl, identifier, label, space = WORKING}) {
  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: buildManifestId(baseUrl, identifier, space),
    type: "Manifest",
    label: {
      none: [label],
    },
    items: [],
  };
}

async function streamToString(body) {
  if (typeof body === "string") return body;
  if (body && typeof body.transformToString === "function") {
    return body.transformToString();
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    body
      .on("data", (chunk) => chunks.push(chunk))
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function readManifest({s3, bucket, identifier, space = WORKING}) {
  const key = manifestObjectKey(identifier, space);
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
  const payload = await streamToString(response.Body);
  return JSON.parse(payload);
}

// The painting body's image service, or — for an audio/video canvas, whose
// body has none — its poster's. An imported A/V poster is copied onto our Image
// API (avCopy.js), so a video work gets a works-list and search thumbnail like
// any other. An uploaded video's MediaConvert poster has no service, so that
// one still has none here.
function canvasThumbnailService(canvas) {
  const service =
    canvas?.items?.[0]?.items?.[0]?.body?.service?.[0] || canvas?.thumbnail?.[0]?.service?.[0];
  return service?.id || null;
}

// A projection, not the raw array: an imported manifest's partOf carries the
// source institution's summary, which can run to a paragraph, and GET /manifests
// returns every manifest in one response under a 6MB cap. id/type/label plus any
// prefixed extension terms is all a caller needs. The generic ":" test keeps this
// module free of any collection import.
function partOfRefs(manifest) {
  const entries = Array.isArray(manifest?.partOf) ? manifest.partOf : [];
  return entries.filter(Boolean).map((entry) => {
    const ref = {id: entry.id, type: entry.type, label: entry.label};
    for (const key of Object.keys(entry)) {
      if (key.includes(":")) ref[key] = entry[key];
    }
    return ref;
  });
}

function manifestSummary(identifier, manifest, space = WORKING) {
  const label = extractLabel(manifest?.label);
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return {
    identifier,
    label,
    manifestUrl: manifest?.id || "",
    relativePath: manifestObjectKey(identifier, space),
    itemCount: items.length,
    thumbnails: items.map(canvasThumbnailService).filter(Boolean),
    partOf: partOfRefs(manifest),
    // Carried on the summary so reindex can rebuild every collection document
    // from one pass over the corpus instead of re-reading each manifest.
    thumbnail: manifestThumbnail(manifest),
  };
}

// `onManifest` lets a caller do per-manifest work inside this one pass — the
// index rebuild needs the whole document to hash, and re-reading the corpus a
// second time would double the IO of the most expensive operation in the app.
async function listManifestSummaries({s3, bucket, space = WORKING, onManifest}) {
  const manifests = [];
  let continuationToken;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${spaceKey(space, MANIFEST_PREFIX)}/`,
        ContinuationToken: continuationToken,
      }),
    );
    const manifestObjects = (response.Contents || []).filter((item) =>
      item.Key.endsWith(`/${MANIFEST_OBJECT}`),
    );
    await Promise.all(
      manifestObjects.map(async (object) => {
        // {space}/presentation/manifest/{id}/manifest.json -> index 3
        const identifier = object.Key.split("/")[3];
        try {
          const manifest = await readManifest({s3, bucket, identifier, space});
          const summary = manifestSummary(identifier, manifest, space);
          manifests.push(summary);
          if (onManifest) await onManifest({identifier, manifest, summary});
        } catch (error) {
          console.error(`Failed to read manifest ${object.Key}:`, error);
        }
      }),
    );
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return manifests.sort(
    (a, b) => a.label.localeCompare(b.label) || a.identifier.localeCompare(b.identifier),
  );
}

module.exports = {
  MANIFEST_PREFIX,
  MANIFEST_OBJECT,
  spaceBase,
  manifestIdPattern,
  sanitizeManifestIdentifier,
  manifestObjectKey,
  buildManifestId,
  createManifestTemplate,
  extractLabel,
  readManifest,
  canvasThumbnailService,
  manifestSummary,
  partOfRefs,
  listManifestSummaries,
};
