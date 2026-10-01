// Copying one canvas's image from a source IIIF Image API into our own.
//
// Moved here verbatim from app/aws/lambdas/manifest/importAssets.js so the
// per-work import walk and the collection import state machine share ONE
// implementation. This is the subtlest code in the repo — Image API v2/v3
// detection, URL rewriting that preserves region/size/rotation, and polling for
// a pyramid TIFF another Lambda is producing — and the repo already has a
// pointed lesson about private copies of shared machinery drifting.
//
// Loads the SDK, so it is NOT unit-testable from the repo root. See the table in
// AGENTS.md under Testing Guidelines.
const {Readable} = require("node:stream");
const {S3Client, HeadObjectCommand} = require("@aws-sdk/client-s3");
const {Upload} = require("@aws-sdk/lib-storage");
// SDK-free and unit-tested, so it lives with the rest of the source-document
// reshaping rather than here.
const {paintingBody} = require("./sourceFetch");
// Audio/video canvases take a different road: their stream is copied verbatim
// into av/, not converted. Dispatched from here so every caller of
// copyCanvasAsset — the per-work walk today — handles both kinds with no change
// of its own.
const {isAvCanvas, hasAuthService, boxedThumbnail} = require("./avImport");
const {safeImageRequest} = require("./imageRequest");
const {copyAvCanvas} = require("./avCopy");

const s3 = new S3Client({});
const iiifBucket = process.env.IIIF_BUCKET;
const sourceBucket = process.env.SOURCE_BUCKET;
const imageApiBase = (process.env.IMAGE_API_BASE_URL || "").replace(/\/$/, "");
const documentsBase = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 280000;

function detectImageApiVersion(info) {
  if (info?.type === "ImageService3") {
    return 3;
  }
  if (info?.["@id"] && !info?.id) {
    return 2;
  }
  const context = info?.["@context"];
  const contextStr = Array.isArray(context) ? context.join(" ") : context || "";
  if (contextStr.includes("/image/2/")) {
    return 2;
  }
  return 3;
}

function largestImageUrl(info) {
  const serviceId = (info?.id || info?.["@id"] || "").replace(/\/$/, "");
  const sizeKeyword = detectImageApiVersion(info) === 3 ? "max" : "full";
  return `${serviceId}/full/${sizeKeyword}/0/default.jpg`;
}

async function fetchJson(url, timeoutMs = 15000) {
  const response = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with status ${response.status}`);
  }
  return response.json();
}

function localService(serviceId, isV3) {
  return {
    id: serviceId,
    type: isV3 ? "ImageService3" : "ImageService2",
    profile: isV3 ? "level2" : "http://iiif.io/api/image/2/level2.json",
  };
}

// Repoints a IIIF list of Image resources (canvas.thumbnail, a placeholder's
// painting body…) at our own service, keeping each one's region and rotation.
//
// The SIZE is not kept verbatim. It used to be — a source's "!300,300" stayed
// "!300,300" — which was harmless on Image API 2 and is not on 3: our v3 server
// refuses `!w,h` whenever the box is bigger than the image on either side, and
// any plain size bigger than the image. safeImageRequest turns it into the
// exact width it would have produced, capped at the image (see
// imageRequest.js). `full` is our copy's pixel size, which that needs.
function repointImageResources(resources, serviceId, isV3, full) {
  if (!Array.isArray(resources)) return;
  for (const resource of resources) {
    if (!resource?.id) continue;
    const request = safeImageRequest(resource.id, {serviceId, full});
    resource.id = request.url;
    if (request.width && request.height) {
      resource.width = request.width;
      resource.height = request.height;
    }
    if (Array.isArray(resource.service)) {
      resource.service = [localService(serviceId, isV3)];
    }
  }
}

// A canvas's thumbnail and placeholderCanvas are derivatives of the same source
// image as its painting body, so they follow it to the service we just created.
function repointCanvasDerivatives(canvas, serviceId, isV3, full) {
  repointImageResources(canvas?.thumbnail, serviceId, isV3, full);
  for (const page of canvas?.placeholderCanvas?.items || []) {
    for (const annotation of page?.items || []) {
      if (annotation?.body) {
        repointImageResources([annotation.body], serviceId, isV3, full);
      }
    }
  }
}

// The work's own thumbnail, copied as an image in its own right.
//
// It used to be REPLACED instead, by the first canvas thumbnail we had copied.
// That was a guess on our part, and a wrong one: the manifest thumbnail is the
// curator's choice of image for the whole work, and the spec does not tie it
// to any canvas. At NUL it is a chosen file set for an image work, or a chosen
// poster or image for an A/V work; elsewhere it need not be one of the
// canvases at all. With several posters, "the first" is arbitrary.
//
// So: whatever the source designates is copied onto our Image API at
// image/{workId}/thumbnail — through its Image service if it has one, from its
// plain URL if not (NUL's has no service). The source having none means we
// have none; we do not invent one (the collection list already falls back to
// the first canvas for display). If the copy fails — restricted, unreachable,
// a format the converter cannot read — the thumbnail is REMOVED, so a
// published work never links to the source for it.
//
// Returns {status, error?} for the caller to record on the import status.
function isOwnThumbnail(thumbnail) {
  if (!thumbnail?.id) return false;
  const serviceId = thumbnail.service?.[0]?.id || thumbnail.service?.[0]?.["@id"];
  if (serviceId) return Boolean(imageApiBase) && serviceId.startsWith(imageApiBase);
  return Boolean(documentsBase) && thumbnail.id.startsWith(`${documentsBase}/`);
}

async function copyManifestThumbnail({identifier, manifest, onPhase}) {
  const reportPhase = async (phase) => {
    if (onPhase) await onPhase(`Work thumbnail: ${phase.charAt(0).toLowerCase()}${phase.slice(1)}`);
  };
  const source = Array.isArray(manifest?.thumbnail) ? manifest.thumbnail[0] : null;
  if (!source?.id) return {status: "none"};
  if (isOwnThumbnail(source)) return {status: "copied"}; // a resumed import

  const drop = (error) => {
    console.warn(`Import-assets: thumbnail for ${identifier} not copied, removing it (${error})`);
    delete manifest.thumbnail;
    return {status: "removed", error};
  };
  if (hasAuthService(source)) return drop("restricted by the source (IIIF Auth)");

  const baseKey = `image/${identifier}/thumbnail`;
  const serviceId = source.service?.[0]?.id || source.service?.[0]?.["@id"];
  let local = null;
  let lastError = null;
  // The service first: it serves its largest size on request, where a sized
  // URL can be one the source itself refuses. The plain URL is the fallback.
  const attempts = [
    ...(serviceId ? [() => copyImageService({serviceId, baseKey, reportPhase})] : []),
    () => copyImageUrl({url: source.id, baseKey, reportPhase}),
  ];
  for (const attempt of attempts) {
    try {
      local = await attempt();
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!local) return drop(lastError?.message || "unknown error");

  const service = localService(local.localServiceId, local.localIsV3);
  // Sized to what the source declared, or a 300px box when it declared nothing.
  const box = source.width && source.height ? Math.max(source.width, source.height) : 300;
  manifest.thumbnail = [
    boxedThumbnail({service, width: local.localInfo.width, height: local.localInfo.height, box}),
  ];
  return {status: "copied"};
}

async function copyCanvasAsset({identifier, canvasIndex, canvas, onPhase}) {
  // The caller owns the status object: with a chunk of canvases in flight at
  // once, each writing its own progress would make them trample each other.
  const reportPhase = async (phase) => {
    if (onPhase) await onPhase(phase);
  };

  if (isAvCanvas(canvas)) {
    // copyImageService is handed in rather than required by avCopy.js, which
    // this module already requires — the reverse would be a cycle.
    return copyAvCanvas({identifier, canvasIndex, canvas, onPhase, copyImageService, localService});
  }

  const body = paintingBody(canvas);
  const serviceId = body?.service?.[0]?.id;
  if (!body || !serviceId) {
    console.warn(`Import-assets: canvas ${canvasIndex} of ${identifier} has no image service, skipping`);
    return;
  }
  if (imageApiBase && serviceId.startsWith(imageApiBase)) {
    // Image is already ours. Its derivatives may not be: earlier imports
    // repointed the painting body only, so make them catch up.
    repointCanvasDerivatives(canvas, serviceId, body.service[0]?.type === "ImageService3", {
      width: body.width,
      height: body.height,
    });
    return;
  }

  const {localServiceId, localIsV3, localInfo} = await copyImageService({
    serviceId,
    baseKey: `image/${identifier}/${canvasIndex}`,
    reportPhase,
  });

  canvas.items[0].items[0].body = {
    id: `${localServiceId}/full/${localIsV3 ? "max" : "full"}/0/default.jpg`,
    type: "Image",
    format: "image/jpeg",
    width: localInfo.width,
    height: localInfo.height,
    service: [localService(localServiceId, localIsV3)],
  };

  repointCanvasDerivatives(canvas, localServiceId, localIsV3, {
    width: localInfo.width,
    height: localInfo.height,
  });
}

// One image, from a source Image API service onto ours: the largest size the
// source serves, uploaded to the source bucket at `${baseKey}.jpg`, waited on
// until the iiif-image Lambda has made its pyramid TIFF, then read back as our
// own service. Shared by image canvases and A/V posters.
//
// It asks the source for its largest size and never for a specific one, which
// is what makes it robust to a source that advertises a thumbnail URL it will
// not actually serve (NUL's poster service returns 400 for its own
// "!300,300" on a 320x240 frame).
async function copyImageService({serviceId, baseKey, reportPhase}) {
  await reportPhase("Fetching image info…");
  const sourceInfo = await fetchJson(`${serviceId.replace(/\/$/, "")}/info.json`);
  return copyImageUrl({url: largestImageUrl(sourceInfo), baseKey, reportPhase});
}

// The formats the iiif-image Lambda converts, keyed by the content type the
// source serves. The extension matters: that Lambda decides by it.
const PIPELINE_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/tiff": ".tif",
};

// Any single image URL -> our Image API. copyImageService is this with the
// URL chosen for it; a plain thumbnail URL (NUL's work thumbnail is one, with
// no service behind it) comes straight here.
async function copyImageUrl({url, baseKey, reportPhase}) {
  await reportPhase("Downloading image…");
  // Anonymous, like every import fetch: only what a stranger could already get.
  const imageResponse = await fetch(url, {credentials: "omit", signal: AbortSignal.timeout(120000)});
  if (!imageResponse.ok || !imageResponse.body) {
    throw new Error(`Unable to download image from ${url} (status ${imageResponse.status})`);
  }
  const contentType = (imageResponse.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const extension = PIPELINE_EXTENSIONS[contentType];
  if (!extension) {
    await imageResponse.body.cancel().catch(() => {});
    throw new Error(`Unable to convert ${contentType} from ${url}`);
  }

  await reportPhase("Uploading to your library…");
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: sourceBucket,
      Key: `${baseKey}${extension}`,
      Body: Readable.fromWeb(imageResponse.body),
      ContentType: contentType,
    },
  });
  await upload.done();

  const tiffKey = `${baseKey}.tif`;
  await reportPhase("Converting image…");
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let converted = false;
  while (Date.now() < deadline) {
    try {
      await s3.send(new HeadObjectCommand({Bucket: iiifBucket, Key: tiffKey}));
      converted = true;
      break;
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== "NotFound") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  if (!converted) {
    throw new Error(`Timed out waiting for pyramid conversion of ${tiffKey}`);
  }

  await reportPhase("Repointing image and thumbnails…");
  const localInfo = await fetchJson(`${imageApiBase}/${encodeURIComponent(baseKey)}/info.json`);
  const localIsV3 = detectImageApiVersion(localInfo) === 3;
  const localServiceId = (localInfo?.id || localInfo?.["@id"] || "").replace(/\/$/, "");
  return {localServiceId, localIsV3, localInfo};
}

module.exports = {
  copyCanvasAsset,
  copyImageService,
  copyImageUrl,
  copyManifestThumbnail,
  paintingBody,
  detectImageApiVersion,
  largestImageUrl,
  fetchJson,
  localService,
  repointImageResources,
  repointCanvasDerivatives,
};
