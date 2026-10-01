// Shared by App.jsx (reorder/remove, manifest fetch/save) and AssetDropzone.jsx
// (upload + attach) — anything that builds or resolves a canvas from an S3 asset key.

const IIIF_BASE_URL = (import.meta.env.VITE_IIIF_BASE_URL || "").replace(/\/$/, "");

export function slugifyManifestId(value) {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildInfoUrlFromKey(key) {
  if (!IIIF_BASE_URL || !key) return "";
  const identifier = key.replace(/\.[^./]+$/, "");
  return `${IIIF_BASE_URL}/${encodeURIComponent(identifier)}/info.json`;
}

export function assetLabelFromKey(key) {
  const basename = (key || "").split("/").filter(Boolean).pop() || "";
  return basename.replace(/\.[^./]+$/, "");
}

// Our Image API is 3.0 (VITE_IIIF_BASE_URL ends /iiif/3). In 3.0 a request
// larger than the image is refused unless it carries `^`, so a fixed-size tile
// — a 64px list thumbnail, a 400px sign-in square — would 400 for any image or
// poster smaller than the tile. For display that is the wrong trade: filling
// the box is the point. So requests to OUR service say `^`.
//
// Only ours: `^` is not valid Image API 2, and a source's service in an import
// preview could be either, so its requests are left exactly as they were.
//
// Written `%5E`, not `^`. Browsers encode it themselves, but our server
// refuses a bare `^` from a client that does not (measured with curl), and
// these URLs can end up in documents other clients read.
const OWN_IMAGE_API_IS_V3 = /\/iiif\/3$/.test(IIIF_BASE_URL);

export function imageRequestUrl(serviceId, {region = "full", size}) {
  const id = (serviceId || "").replace(/\/$/, "");
  const own = OWN_IMAGE_API_IS_V3 && id.startsWith(`${IIIF_BASE_URL}/`);
  return `${id}/${region}/${own ? "%5E" : ""}${size}/0/default.jpg`;
}

// A resolved IIIF image info response is always servable as a thumbnail JPEG,
// unlike the original upload (which may be a browser-unrenderable format like TIFF).
export function buildThumbnailUrlFromInfo(imageInfo, size = 64) {
  const serviceId = imageInfo?.id || imageInfo?.["@id"];
  if (!serviceId) return null;
  return imageRequestUrl(serviceId, {size: `,${size}`});
}

export function buildCanvasResource(manifest, imageInfo, label) {
  if (!manifest?.id) {
    throw new Error("Work is missing an id");
  }
  // Our service is Image API 3 (`id`, `type`), but a v2 info (`@context`/`@id`)
  // is still read correctly, so either base works.
  const imageId = imageInfo?.id || imageInfo?.["@id"];
  if (!imageId) {
    throw new Error("Image info is missing an id");
  }
  const isImageApi2 =
    /\/image\/2\//.test(imageInfo?.["@context"] || "") || (!imageInfo?.id && Boolean(imageInfo?.["@id"]));
  const manifestBase = manifest.id.replace(/\/manifest\.json$/i, "");
  const normalizedLabel = label?.trim() || "Asset";
  const slugBase = slugifyManifestId(normalizedLabel) || slugifyManifestId(imageId.split("/").pop() || "");
  const uniqueSlug = slugBase ? `${slugBase}-${Date.now().toString(36)}` : Date.now().toString(36);
  const canvasId = `${manifestBase}/canvas/${uniqueSlug}`;
  const pageId = `${canvasId}/page/1`;
  const annotationId = `${canvasId}/annotation/1`;
  const serviceId = imageId.replace(/\/$/, "");
  const imageService = {
    id: serviceId,
    type: imageInfo.type || (isImageApi2 ? "ImageService2" : "ImageService3"),
    profile: Array.isArray(imageInfo.profile)
      ? imageInfo.profile[0]
      : imageInfo.profile || "level0",
    width: imageInfo.width,
    height: imageInfo.height,
  };
  const canvas = {
    id: canvasId,
    type: "Canvas",
    width: imageInfo.width,
    height: imageInfo.height,
    items: [
      {
        id: pageId,
        type: "AnnotationPage",
        items: [
          {
            id: annotationId,
            type: "Annotation",
            motivation: "painting",
            target: canvasId,
            body: {
              id: `${serviceId}/full/${isImageApi2 ? "full" : "max"}/0/default.jpg`,
              type: "Image",
              format: "image/jpeg",
              width: imageInfo.width,
              height: imageInfo.height,
              service: [imageService],
            },
          },
        ],
      },
    ],
  };
  if (normalizedLabel) {
    canvas.label = {none: [normalizedLabel]};
  }
  return canvas;
}

// --- Audio and video --------------------------------------------------------
//
// An A/V upload lands at av/{workId}/{assetId}.{ext} in the source bucket, and
// the av-transcode Lambda reports on it in {documents base}/av/{workId}/{assetId}/media.json
// (app/shared/av.js). That base is IIIF_BASE_URL on the backend, which the UI
// has no variable for — VITE_IIIF_BASE_URL is the Image API — but every
// manifest id already starts with it, so it is read from there rather than
// adding a setting that could drift.

export function mediaKindFromFile(file) {
  const type = file?.type || "";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  return null;
}

function documentsBaseFromManifestId(manifestId) {
  const match = /^(.*)\/(?:working|published)\/presentation\/manifest\//.exec(manifestId || "");
  return match ? match[1] : "";
}

export function buildMediaStatusUrl(manifest, key) {
  const base = documentsBaseFromManifestId(manifest?.id);
  if (!base || !key) return "";
  return `${base}/${key.replace(/\.[^./]+$/, "")}/media.json`;
}

// `media` is a ready media.json: {kind, format, streamUrl, duration, width?,
// height?, poster?}. Id shape matches buildCanvasResource so uploaded canvases
// of every kind agree.
export function buildAvCanvasResource(manifest, media, label) {
  if (!manifest?.id) {
    throw new Error("Work is missing an id");
  }
  if (media?.status !== "ready" || !media.streamUrl) {
    throw new Error("Media is not ready yet");
  }
  const isVideo = media.kind === "video";
  const manifestBase = manifest.id.replace(/\/manifest\.json$/i, "");
  const normalizedLabel = label?.trim() || (isVideo ? "Video" : "Audio");
  const slugBase = slugifyManifestId(normalizedLabel);
  const uniqueSlug = slugBase ? `${slugBase}-${Date.now().toString(36)}` : Date.now().toString(36);
  const canvasId = `${manifestBase}/canvas/${uniqueSlug}`;
  const hasSize = isVideo && media.width && media.height;

  const body = {
    id: media.streamUrl,
    type: isVideo ? "Video" : "Sound",
    format: media.format,
    duration: media.duration,
  };
  if (hasSize) {
    body.width = media.width;
    body.height = media.height;
  }

  const canvas = {
    id: canvasId,
    type: "Canvas",
    duration: media.duration,
    ...(hasSize ? {width: media.width, height: media.height} : {}),
    items: [
      {
        id: `${canvasId}/page/1`,
        type: "AnnotationPage",
        items: [
          {
            id: `${canvasId}/annotation/1`,
            type: "Annotation",
            motivation: "painting",
            target: canvasId,
            body,
          },
        ],
      },
    ],
  };
  if (media.poster?.url) {
    canvas.thumbnail = [
      {
        id: media.poster.url,
        type: "Image",
        format: "image/jpeg",
        ...(media.poster.width && media.poster.height
          ? {width: media.poster.width, height: media.poster.height}
          : {}),
      },
    ];
  }
  canvas.label = {none: [normalizedLabel]};
  return canvas;
}
