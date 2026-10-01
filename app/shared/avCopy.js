// Copying one audio/video canvas's media from its source into our own av/.
//
// The A/V counterpart of the image half of assetCopy.js, and called from the
// same place (copyCanvasAsset), so the per-work walk gets it with no changes to
// its loop. Every decision — what a playlist references, where each file goes,
// what must be refused — is made by the pure code in hls.js and avImport.js;
// this file only fetches and writes.
//
// Loads the SDK, so it is NOT unit-testable from the repo root.
//
// Layout: av/{workId}/imported-{canvasIndex}/…, beside UI uploads (which use a
// random assetId). Named by index, not a random id, so a resumed or retried
// import writes the same keys — the same idempotency rule localizeStructuralIds
// follows. Nothing is written to the source bucket, so recovery
// (GET /manifests/{id}/media, which lists the source bucket) never sees these.
//
// Anonymous fetches only. See the note at the top of avImport.js.

const {Readable} = require("node:stream");
const {S3Client, PutObjectCommand} = require("@aws-sdk/client-s3");
const {Upload} = require("@aws-sdk/lib-storage");
const {paintingBody} = require("./sourceFetch");
const {avCopyMode, hasAuthService, boxedThumbnail} = require("./avImport");
const {
  HLS_CONTENT_TYPE,
  analyzePlaylist,
  rewritePlaylist,
  directoryOf,
  localPathFor,
  relativeReference,
  masterFileName,
  contentTypeFor,
  withoutQuery,
} = require("./hls");

const s3 = new S3Client({});
const iiifBucket = process.env.IIIF_BUCKET;
const documentsBase = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");

// Files in flight per canvas. The walk runs up to 10 canvases at once, and a
// source's streaming server is somebody else's: 8 x a few A/V canvases is the
// ceiling we put on it.
const FILE_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 60000;
const MAX_PLAYLISTS = 50;
// Sanity valve, not a size limit: two hours of 2s segments across three
// quality levels is ~11,000 files.
const MAX_FILES = 30000;
// Small files are buffered and PUT; anything larger or of unknown size streams
// through a multipart upload.
const BUFFER_LIMIT_BYTES = 32 * 1024 * 1024;

class RestrictedMediaError extends Error {}

function outputPrefix(identifier, canvasIndex) {
  return `av/${identifier}/imported-${canvasIndex}`;
}

// One anonymous GET, with a couple of retries for the transient failures a big
// copy will meet. 401/403 is never retried: the answer would be the same.
async function anonymousFetch(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    try {
      const response = await fetch(url, {
        credentials: "omit",
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        throw new RestrictedMediaError(`Restricted by the source (HTTP ${response.status} for ${url})`);
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`The source returned HTTP ${response.status} for ${url}`);
        continue;
      }
      if (!response.ok) throw new Error(`The source returned HTTP ${response.status} for ${url}`);
      return response;
    } catch (error) {
      if (error instanceof RestrictedMediaError) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function putText(key, text, contentType) {
  await s3.send(
    new PutObjectCommand({Bucket: iiifBucket, Key: key, Body: text, ContentType: contentType}),
  );
}

async function copyUrlToKey(url, key) {
  const response = await anonymousFetch(url);
  // By extension first, so segments are served consistently whatever the
  // source's server claims; its header only fills in what the name cannot.
  const guessed = contentTypeFor(key);
  const contentType =
    guessed !== "application/octet-stream"
      ? guessed
      : (response.headers.get("content-type") || guessed).split(";")[0].trim();
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 0 && length <= BUFFER_LIMIT_BYTES) {
    const body = Buffer.from(await response.arrayBuffer());
    await s3.send(new PutObjectCommand({Bucket: iiifBucket, Key: key, Body: body, ContentType: contentType}));
    return;
  }
  if (!response.body) throw new Error(`Empty response for ${url}`);
  await new Upload({
    client: s3,
    params: {Bucket: iiifBucket, Key: key, Body: Readable.fromWeb(response.body), ContentType: contentType},
  }).done();
}

// Copy a whole HLS package. Returns the master playlist's path inside the copy.
//
// Playlists are walked breadth first and written as they are read, each with
// its references rewritten to point inside the copy — which, for a normally
// shaped stream like NUL's, changes nothing (hls.test.js checks that). Every
// other file is collected, de-duplicated (byte ranges name one file many
// times) and copied afterwards, FILE_CONCURRENCY at a time.
async function copyHlsPackage(masterUrl, prefix, reportPhase) {
  await reportPhase("Reading stream playlists…");
  const first = await anonymousFetch(masterUrl);
  const masterFinalUrl = first.url || masterUrl;
  const rootDirectory = directoryOf(masterFinalUrl);
  const masterLocal = masterFileName(masterFinalUrl);

  const queue = [{url: masterFinalUrl, local: masterLocal, text: await first.text()}];
  const queued = new Set([masterLocal]);
  const files = new Map(); // local path -> source URL

  while (queue.length) {
    const playlist = queue.shift();
    if (playlist.text === null) {
      const response = await anonymousFetch(playlist.url);
      // Its own references resolve against where it actually came from.
      playlist.url = response.url || playlist.url;
      playlist.text = await response.text();
    }
    const analysis = analyzePlaylist(playlist.text);
    // Screening at import time refuses these already; this is the backstop for
    // a stream that changed in between.
    if (analysis.problems.length) throw new Error(analysis.problems[0].message);

    const rewritten = rewritePlaylist(playlist.text, (uri, ref) => {
      const resolved = new URL(uri, playlist.url).toString();
      let local = localPathFor(resolved, rootDirectory);
      // A playlist renamed under _ext/ keeps a playlist's extension, so it is
      // served with a playlist's content type.
      if (ref.playlist && !/\.m3u8?$/i.test(local)) local += ".m3u8";
      if (ref.playlist) {
        if (!queued.has(local)) {
          queued.add(local);
          if (queued.size > MAX_PLAYLISTS) throw new Error("The stream has too many playlists to copy");
          queue.push({url: resolved, local, text: null});
        }
      } else {
        files.set(local, resolved);
        if (files.size > MAX_FILES) throw new Error("The stream has too many files to copy");
      }
      return relativeReference(playlist.local, local);
    });
    await putText(`${prefix}/${playlist.local}`, rewritten, HLS_CONTENT_TYPE);
  }

  const entries = [...files.entries()];
  let copied = 0;
  let cursor = 0;
  let lastReport = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [local, url] = entries[cursor];
      cursor += 1;
      await copyUrlToKey(url, `${prefix}/${local}`);
      copied += 1;
      if (Date.now() - lastReport > 1000 || copied === entries.length) {
        lastReport = Date.now();
        await reportPhase(`Copying stream… ${copied} of ${entries.length} files`);
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(FILE_CONCURRENCY, entries.length)}, worker));
  return masterLocal;
}

async function copySingleFile(url, prefix, reportPhase) {
  await reportPhase("Copying media file…");
  const name = withoutQuery(url).split("/").pop() || "media";
  const local = /^[A-Za-z0-9._~-]+$/.test(name) ? name : `media${(/\.[A-Za-z0-9]{1,5}$/.exec(name) || [""])[0]}`;
  await copyUrlToKey(url, `${prefix}/${local}`);
  return local;
}

// The canvas's poster. Best effort: a missing or restricted poster costs a
// thumbnail, never the canvas. Returns {thumbnail, placeholderBody} or null.
//
// A poster with an Image API service (NUL's have one) goes through the SAME
// pipeline as an image canvas — pyramid TIFF, our own service — at
// image/{workId}/{n}-poster. That was not the first version: it fetched the
// thumbnail URL as advertised, which for NUL's Bienen video is a "!300,300"
// their own server refuses with a 400, so the poster was dropped, and the
// manifest-level thumbnail was left pointing at NUL with nothing of ours to
// replace it. Asking a service for its largest size cannot hit that.
//
// A poster that is only a plain URL is copied as a file beside the stream.
async function copyPoster({canvas, identifier, canvasIndex, prefix, copyImageService, localService, reportPhase}) {
  const source = canvas?.thumbnail?.[0];
  if (typeof source?.id !== "string" || hasAuthService(source)) return null;

  const serviceId = source.service?.[0]?.id || source.service?.[0]?.["@id"];
  if (serviceId && copyImageService) {
    try {
      const {localServiceId, localIsV3, localInfo} = await copyImageService({
        serviceId,
        baseKey: `image/${identifier}/${canvasIndex}-poster`,
        reportPhase: (phase) => reportPhase(`Poster: ${phase.charAt(0).toLowerCase()}${phase.slice(1)}`),
      });
      const service = localService(localServiceId, localIsV3);
      return {
        thumbnail: boxedThumbnail({service, width: localInfo.width, height: localInfo.height}),
        placeholderBody: {
          id: `${localServiceId}/full/${localIsV3 ? "max" : "full"}/0/default.jpg`,
          type: "Image",
          format: "image/jpeg",
          width: localInfo.width,
          height: localInfo.height,
          service: [service],
        },
      };
    } catch (error) {
      console.warn(`Import-assets: poster service for ${prefix} not copied, trying the file (${error.message})`);
    }
  }
  return copyPosterFile(source, prefix);
}

async function copyPosterFile(source, prefix) {
  try {
    const response = await anonymousFetch(source.id);
    const type = (response.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const extension = type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : ".jpg";
    const key = `${prefix}/poster${extension}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: iiifBucket,
        Key: key,
        Body: Buffer.from(await response.arrayBuffer()),
        ContentType: type,
      }),
    );
    const image = {
      id: `${documentsBase}/${key}`,
      type: "Image",
      format: type,
      ...(source.width && source.height ? {width: source.width, height: source.height} : {}),
    };
    return {thumbnail: image, placeholderBody: image};
  } catch (error) {
    console.warn(`Import-assets: poster for ${prefix} not copied (${error.message})`);
    return null;
  }
}

// The poster stands in for every derivative the source pointed at its own
// image server with — canvas.thumbnail and placeholderCanvas — so nothing on
// the canvas keeps a foreign link. Without a poster they are removed rather
// than left pointing at the source.
function repointAvDerivatives(canvas, poster) {
  if (poster) {
    canvas.thumbnail = [poster.thumbnail];
  } else {
    delete canvas.thumbnail;
  }
  if (!canvas.placeholderCanvas) return;
  if (!poster) {
    delete canvas.placeholderCanvas;
    return;
  }
  for (const page of canvas.placeholderCanvas.items || []) {
    for (const annotation of page?.items || []) {
      if (annotation?.body?.type === "Image") {
        annotation.body = structuredClone(poster.placeholderBody);
      }
    }
  }
}

async function copyAvCanvas({identifier, canvasIndex, canvas, onPhase, copyImageService, localService}) {
  const reportPhase = async (phase) => {
    if (onPhase) await onPhase(phase);
  };
  const body = paintingBody(canvas);
  // Already ours: a resumed import walks past it.
  if (documentsBase && typeof body?.id === "string" && body.id.startsWith(`${documentsBase}/av/`)) return;

  // Screening refused these at import time; checked again because the walk
  // must never copy something screening would have refused.
  if (hasAuthService(body) || hasAuthService(canvas)) {
    throw new RestrictedMediaError("Restricted by the source (IIIF Auth)");
  }
  const {mode, reason} = avCopyMode(body);
  if (!mode) throw new Error(reason);

  const prefix = outputPrefix(identifier, canvasIndex);
  const local =
    mode === "hls"
      ? await copyHlsPackage(body.id, prefix, reportPhase)
      : await copySingleFile(body.id, prefix, reportPhase);
  const poster = await copyPoster({
    canvas,
    identifier,
    canvasIndex,
    prefix,
    copyImageService,
    localService,
    reportPhase,
  });

  await reportPhase("Repointing media…");
  // Repointed only once everything is written, so a canvas never points at a
  // half-copied stream. Type, duration, size and label are the source's and
  // stay as they are.
  body.id = `${documentsBase}/${prefix}/${local}`;
  delete body.service;
  repointAvDerivatives(canvas, poster);
}

module.exports = {copyAvCanvas, RestrictedMediaError, outputPrefix};
