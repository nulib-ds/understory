const crypto = require("node:crypto");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const {
  sanitizeManifestIdentifier,
  manifestObjectKey,
  buildManifestId,
  createManifestTemplate,
  extractLabel,
  canvasThumbnailService,
  manifestSummary,
} = require("../../../shared/manifest");
const {
  managedCollectionRefs,
  stripForeignManagedEntries,
} = require("../../../shared/collection");
const {jsonResponse, parseBody, isNotFound} = require("./http");
const {INTERNAL_PREFIX} = require("../../../shared/space");
const {AV_PREFIX} = require("../../../shared/av");
const {readManifest, writeManifest} = require("./store");
const {
  upsertQuietly,
  removeQuietly,
  listWorks,
  syncCounts,
  SYNC_NEW,
  SYNC_CHANGED,
} = require("./workIndex");
const {
  principalFromEvent,
  canEditWork,
  canCreateWork,
  canViewWork,
} = require("../../../shared/access");
const {handleUsersRoute} = require("./users");
const {handleMediaRoute} = require("./mediaRoutes");
const {
  handleCollectionsRoute,
  handleManifestCollectionRoute,
  reconcileQuietly,
  fileNewWork,
  desiredCollectionSlugs,
} = require("./collections");
const {
  ImportError,
  validateSourceUrl,
  fetchSourceDocument,
  localizeStructuralIds,
} = require("../../../shared/sourceFetch");
const {
  triggerAssetImport,
  handleImportAssets,
  readImportStatus,
  resumeAssetImport,
  handleImportFailure,
} = require("./importAssets");

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;
const sourceBucket = process.env.SOURCE_BUCKET;
const manifestBaseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");
const imageApiBase = (process.env.IMAGE_API_BASE_URL || "").replace(/\/$/, "");
const SOURCE_IMAGE_EXTENSIONS = ["jpg", "jpeg", "tif", "tiff", "png", "webp"];

function keyFromImageServiceId(serviceId) {
  if (!serviceId || !imageApiBase || !serviceId.startsWith(`${imageApiBase}/`)) {
    return null;
  }
  try {
    return decodeURIComponent(serviceId.slice(imageApiBase.length + 1));
  } catch (error) {
    return null;
  }
}

async function deleteKeys(targetBucket, keys) {
  const uniqueKeys = [...new Set(keys)].filter(Boolean);
  for (let i = 0; i < uniqueKeys.length; i += 1000) {
    const batch = uniqueKeys.slice(i, i + 1000);
    if (batch.length === 0) continue;
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: targetBucket,
        Delete: {Objects: batch.map((Key) => ({Key}))},
      }),
    );
  }
}

async function deleteByPrefix(targetBucket, prefix) {
  let continuationToken;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({Bucket: targetBucket, Prefix: prefix, ContinuationToken: continuationToken}),
    );
    await deleteKeys(targetBucket, (response.Contents || []).map((object) => object.Key));
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
}

async function deleteManifestAssets(identifier, manifest) {
  const assetPrefix = `image/${identifier}/`;
  // Audio/video: the upload in source, and the renditions + media.json in iiif.
  const avPrefix = `${AV_PREFIX}/${identifier}/`;
  await Promise.all([
    deleteByPrefix(sourceBucket, assetPrefix),
    deleteByPrefix(bucket, assetPrefix),
    deleteByPrefix(sourceBucket, avPrefix),
    deleteByPrefix(bucket, avPrefix),
  ]);

  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const extraSourceKeys = [];
  const extraIiifKeys = [];
  for (const canvas of items) {
    const serviceId = canvas?.items?.[0]?.items?.[0]?.body?.service?.[0]?.id;
    const keyWithoutExt = keyFromImageServiceId(serviceId);
    if (!keyWithoutExt || keyWithoutExt.startsWith(assetPrefix)) {
      continue; // already handled by the prefix delete above
    }
    extraIiifKeys.push(`${keyWithoutExt}.tif`);
    for (const ext of SOURCE_IMAGE_EXTENSIONS) {
      extraSourceKeys.push(`${keyWithoutExt}.${ext}`);
    }
  }
  await Promise.all([deleteKeys(sourceBucket, extraSourceKeys), deleteKeys(bucket, extraIiifKeys)]);
}

function manifestDetail(identifier, manifest) {
  return {
    ...manifestSummary(identifier, manifest),
    // Derived from partOf rather than stored separately — the manifest is the
    // authority on what it belongs to. Singular: a work belongs to exactly one.
    collection: managedCollectionRefs(manifest?.partOf, {baseUrl: manifestBaseUrl})[0] || null,
    manifest,
  };
}

// Only these manifest-level fields may be written through the API. Everything
// else — id, type, @context, items, thumbnail, partOf — is owned by the server,
// so a
// request body can never reach them. Collection membership lives in partOf and
// has side effects on other objects, so it gets its own sub-resource route.
const EDITABLE_MANIFEST_FIELDS = ["label", "summary", "metadata", "behavior"];

// A IIIF language map: {"none": ["value", ...]} — every value an array of strings.
function isLanguageMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value);
  if (entries.length === 0) return false;
  return entries.every(
    (entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"),
  );
}

function validateManifestField(field, value) {
  if (value === null) return null; // an explicit null unsets the field
  switch (field) {
    case "label":
    case "summary":
      return isLanguageMap(value) ? null : `${field} must be a language map`;
    case "metadata":
      if (!Array.isArray(value)) return "metadata must be an array";
      return value.every((entry) => entry && isLanguageMap(entry.label) && isLanguageMap(entry.value))
        ? null
        : "each metadata entry must have a label and value language map";
    case "behavior":
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? null
        : "behavior must be an array of strings";
    default:
      return `${field} is not editable`;
  }
}



// The collections a work currently belongs to — the input to every edit check.
function workCollections(manifest) {
  return managedCollectionRefs(manifest?.partOf, {baseUrl: manifestBaseUrl});
}

const FORBIDDEN_EDIT = {
  error: "You can only change works in a collection you have been granted",
};

const FORBIDDEN_VIEW = {
  error: "You do not have access to this work",
};

exports.handler = async (event) => {
  if (event?.source === "lambda" && event?.detail?.requestContext?.condition) {
    return handleImportFailure(event.detail);
  }

  if (event?.action === "importAssets") {
    // reconcileQuietly is handed in here because collections.js requires
    // importAssets.js, so importAssets.js cannot require it back.
    return handleImportAssets({...event, reconcile: reconcileQuietly});
  }

  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  const rawPath = event?.rawPath || event?.path || "/";
  const segments = rawPath
    .split("/")
    .filter(Boolean);

  if (method === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  // Roles and collection grants both ride in the ID token as `cognito:groups`,
  // so this is a pure read of already-verified claims — the JWT authorizer has
  // established WHO the caller is before anything here runs.
  //
  // Reads stay open to any signed-in user; every guard below is on a write.
  const principal = principalFromEvent(event);

  if (segments[0] === "users") {
    return handleUsersRoute({ method, segments, event, principal });
  }

  if (segments[0] === "collections") {
    return handleCollectionsRoute({ method, segments, principal, event });
  }

  if (segments[0] !== "manifests") {
    return jsonResponse(404, { error: "Not found" });
  }

  if (segments.length === 1) {
    if (method === "POST") {
      try {
        const body = parseBody(event);
        const label = (body.label || "").trim();
        if (!label) {
          return jsonResponse(400, { error: "Label is required" });
        }
        // An editor must file a new work into a collection they hold, or they
        // would immediately lose the ability to edit what they just made.
        // Admins may leave it uncollected.
        if (!canCreateWork(principal, desiredCollectionSlugs(body.collection))) {
          return jsonResponse(403, {
            error: "Choose one collection you have been granted to create this work in",
          });
        }
        const identifier = crypto.randomUUID();
        const template = createManifestTemplate({ baseUrl: manifestBaseUrl, identifier, label });
        await writeManifest(identifier, template, {syncState: SYNC_NEW});
        const manifest = await fileNewWork({
          identifier,
          manifest: template,
          slug: body.collection,
          writeManifest,
        });
        return jsonResponse(201, { manifest: manifestDetail(identifier, manifest) });
      } catch (error) {
        if (error.message === "Invalid JSON payload") {
          return jsonResponse(400, { error: error.message });
        }
        console.error("Create manifest failed", error);
        return jsonResponse(500, { error: error.message });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (method === "POST" && segments.length === 3 && segments[1] === "import" && segments[2] === "preview") {
    try {
      const body = parseBody(event);
      const sourceUrl = validateSourceUrl(body.sourceUrl);
      const manifest = await fetchSourceDocument(sourceUrl, {expect: "Manifest"});
      const label = extractLabel(manifest.label);
      const itemCount = Array.isArray(manifest.items) ? manifest.items.length : 0;
      const thumbnail = itemCount > 0 ? canvasThumbnailService(manifest.items[0]) : null;
      return jsonResponse(200, { label, itemCount, thumbnail, sourceUrl, manifest });
    } catch (error) {
      if (error.message === "Invalid JSON payload") {
        return jsonResponse(400, { error: error.message });
      }
      if (error instanceof ImportError) {
        return jsonResponse(error.status, { error: error.message });
      }
      console.error("Import preview failed", error);
      return jsonResponse(500, { error: "Unable to preview manifest" });
    }
  }

  if (method === "POST" && segments.length === 2 && segments[1] === "import") {
    try {
      const body = parseBody(event);
      const sourceUrl = validateSourceUrl(body.sourceUrl);
      const manifest = body.manifest;
      if (!manifest || typeof manifest !== "object" || manifest.type !== "Manifest") {
        return jsonResponse(400, { error: "A valid Manifest is required" });
      }
      if (!canCreateWork(principal, desiredCollectionSlugs(body.collection))) {
        return jsonResponse(403, {
          error: "Choose one collection you have been granted to import this work into",
        });
      }
      const identifier = crypto.randomUUID();
      // The source institution's own partOf is kept verbatim as provenance. Only
      // entries claiming to be *ours* while pointing somewhere we don't own are
      // dropped — that happens when importing from another static-iiif
      // deployment, and keeping them would invent collections nobody asked for.
      // localizeStructuralIds AFTER the id is set — it derives every canvas,
      // page and annotation id from the manifest's own. Without it the work
      // keeps the source's identifiers for everything inside it.
      const importedManifest = localizeStructuralIds(
        stripForeignManagedEntries(
          {
            ...manifest,
            id: buildManifestId(manifestBaseUrl, identifier),
          },
          {baseUrl: manifestBaseUrl},
        ),
      );
      await writeManifest(identifier, importedManifest, {syncState: SYNC_NEW});
      const filedManifest = await fileNewWork({
        identifier,
        manifest: importedManifest,
        slug: body.collection,
        writeManifest,
      });
      try {
        // `items` is optional in the spec, and a Manifest that omits it threw a
        // TypeError here — into the generic catch, returning a 500 AFTER the
        // work had already been written and filed. triggerAssetImport already
        // no-ops on a total of 0.
        await triggerAssetImport({
          identifier,
          total: Array.isArray(importedManifest.items) ? importedManifest.items.length : 0,
        });
      } catch (error) {
        console.error("Failed to start asset import", error);
      }
      return jsonResponse(201, { manifest: manifestDetail(identifier, filedManifest) });
    } catch (error) {
      if (error.message === "Invalid JSON payload") {
        return jsonResponse(400, { error: error.message });
      }
      if (error instanceof ImportError) {
        return jsonResponse(error.status, { error: error.message });
      }
      console.error("Import manifest failed", error);
      return jsonResponse(500, { error: error.message });
    }
  }

  const rawIdentifier = decodeURIComponent(segments[1] || "");
  let identifier;
  try {
    identifier = sanitizeManifestIdentifier(rawIdentifier);
  } catch (error) {
    return jsonResponse(400, { error: error.message });
  }

  if (segments.length === 2) {
    if (method === "GET") {
      try {
        const manifest = await readManifest(identifier);
        if (!canViewWork(principal, workCollections(manifest))) {
          return jsonResponse(403, FORBIDDEN_VIEW);
        }
        return jsonResponse(200, { manifest: manifestDetail(identifier, manifest) });
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
          return jsonResponse(404, { error: "Manifest not found" });
        }
        console.error("Read manifest failed", error);
        return jsonResponse(500, { error: "Unable to load manifest" });
      }
    }

    if (method === "PUT") {
      try {
        const body = parseBody(event);
        const updates = EDITABLE_MANIFEST_FIELDS.filter((field) =>
          Object.prototype.hasOwnProperty.call(body, field),
        );
        if (updates.length === 0) {
          return jsonResponse(400, {
            error: `Provide at least one of: ${EDITABLE_MANIFEST_FIELDS.join(", ")}`,
          });
        }
        for (const field of updates) {
          const problem = validateManifestField(field, body[field]);
          if (problem) {
            return jsonResponse(400, { error: problem });
          }
        }

        const manifest = await readManifest(identifier);
        if (!canEditWork(principal, workCollections(manifest))) {
          return jsonResponse(403, FORBIDDEN_EDIT);
        }
        for (const field of updates) {
          if (body[field] === null) {
            delete manifest[field];
          } else {
            manifest[field] = body[field];
          }
        }
        await writeManifest(identifier, manifest);
        if (updates.includes("label")) {
          // Collection documents cache each member's title. A stale one is
          // visible to every downstream consumer of a public IIIF document, so
          // refresh it here rather than waiting for the next reindex. Membership
          // is unchanged, so this is usually reads and no writes.
          await reconcileQuietly({ manifest });
        }
        return jsonResponse(200, { manifest: manifestDetail(identifier, manifest) });
      } catch (error) {
        if (error.message === "Invalid JSON payload") {
          return jsonResponse(400, { error: error.message });
        }
        if (isNotFound(error)) {
          return jsonResponse(404, { error: "Manifest not found" });
        }
        console.error("Update manifest failed", error);
        return jsonResponse(500, { error: "Unable to update manifest" });
      }
    }

    if (method === "DELETE") {
      try {
        const manifest = await readManifest(identifier);
        if (!canEditWork(principal, workCollections(manifest))) {
          return jsonResponse(403, FORBIDDEN_EDIT);
        }
        await deleteManifestAssets(identifier, manifest);
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: manifestObjectKey(identifier) }));
        await s3
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: `${INTERNAL_PREFIX}/import-status/${identifier}.json` }))
          .catch(() => {});
        // Truth first (the manifest is gone), projection second. A failure here
        // is logged, not surfaced: the delete itself succeeded, and a reindex
        // repairs the leftovers.
        await removeQuietly(identifier);
        await reconcileQuietly({ manifest, desired: [], removed: true });
        return jsonResponse(200, { deleted: true });
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
          return jsonResponse(404, { error: "Manifest not found" });
        }
        console.error("Delete manifest failed", error);
        return jsonResponse(500, { error: "Unable to delete manifest" });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (segments.length === 3 && segments[2] === "collection") {
    return handleManifestCollectionRoute({
      method,
      identifier,
      event,
      principal,
      readManifest,
      writeManifest,
    });
  }

  if ((segments.length === 3 || segments.length === 4) && segments[2] === "media") {
    return handleMediaRoute({
      method,
      identifier,
      assetId: segments[3] === undefined ? undefined : decodeURIComponent(segments[3]),
      principal,
      readManifest,
      canEdit: (who, manifest) => canEditWork(who, workCollections(manifest)),
    });
  }

  if (segments.length === 3 && segments[2] === "items") {
    if (method === "PUT") {
      try {
        const body = parseBody(event);
        if (!Array.isArray(body.items)) {
          return jsonResponse(400, { error: "items must be an array" });
        }
        const manifest = await readManifest(identifier);
        if (!canEditWork(principal, workCollections(manifest))) {
          return jsonResponse(403, FORBIDDEN_EDIT);
        }
        manifest.items = body.items;
        await writeManifest(identifier, manifest);
        return jsonResponse(200, { manifest: manifestDetail(identifier, manifest) });
      } catch (error) {
        if (error.message === "Invalid JSON payload") {
          return jsonResponse(400, { error: error.message });
        }
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
          return jsonResponse(404, { error: "Manifest not found" });
        }
        console.error("Update manifest items failed", error);
        return jsonResponse(500, { error: "Unable to update manifest" });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (segments.length === 3 && segments[2] === "import-status") {
    if (method === "GET") {
      try {
        // The status carries per-canvas labels, so it is as revealing as the
        // work itself and takes the same guard.
        const manifest = await readManifest(identifier);
        if (!canViewWork(principal, workCollections(manifest))) {
          return jsonResponse(403, FORBIDDEN_VIEW);
        }
        const status = await readImportStatus(identifier);
        return jsonResponse(200, status);
      } catch (error) {
        console.error("Read import status failed", error);
        return jsonResponse(500, { error: "Unable to load import status" });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (segments.length === 3 && segments[2] === "import-resume") {
    if (method === "POST") {
      try {
        // Resuming restarts a pipeline that rewrites the manifest, so it needs
        // the same rights as any other edit. Costs one extra read on a route
        // that is only hit when an import has stalled.
        const manifest = await readManifest(identifier);
        if (!canEditWork(principal, workCollections(manifest))) {
          return jsonResponse(403, FORBIDDEN_EDIT);
        }
        const status = await resumeAssetImport({ identifier });
        return jsonResponse(200, status);
      } catch (error) {
        console.error("Resume import failed", error);
        return jsonResponse(500, { error: "Unable to resume import" });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  return jsonResponse(404, { error: "Unknown endpoint" });
};
