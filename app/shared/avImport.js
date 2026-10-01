// Deciding, at import time, which of a source manifest's audio/video canvases
// we can host — and saying why for the ones we cannot.
//
// SDK-free, and `fetch` is injected, so it is unit-testable. The copy itself is
// app/shared/avCopy.js.
//
// We COPY a source's stream rather than re-transcoding it: lossless, and no
// MediaConvert bill. That works for HLS and for a single browser-playable file.
//
// The rule that matters most: **we only copy what an anonymous stranger could
// already fetch.** Nothing here sends a cookie or a token, so a copy can never
// make anything more public than the source already does. A source that
// restricts a stream (NUL's Institution-only works return 403) is refused and
// reported, never worked around — and no credential should ever be added here
// "to make it work", because that is exactly how restricted media would leak
// into a publicly served bucket.

const {analyzePlaylist} = require("./hls");
const {paintingBody} = require("./sourceFetch");

const AV_TYPES = new Set(["Sound", "Video"]);
const HLS_FORMATS = new Set([
  "application/x-mpegurl",
  "application/vnd.apple.mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "vnd.apple.mpegurl",
]);
// A single file a browser plays natively, so it can be served as-is.
const PLAYABLE_FILE_FORMATS = new Set([
  "video/mp4",
  "video/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/aac",
  "audio/webm",
]);
const PLAYABLE_FILE_EXTENSIONS = new Set([".mp4", ".m4v", ".m4a", ".mp3", ".aac", ".webm"]);

const FETCH_TIMEOUT_MS = 10000;
// Playlists fetched while screening one stream. A real master has a handful;
// this bounds a hostile or broken one.
const MAX_PLAYLISTS = 50;

function isAvCanvas(canvas) {
  return AV_TYPES.has(paintingBody(canvas)?.type);
}

function extensionOf(url) {
  try {
    return (/\.[A-Za-z0-9]{1,5}$/.exec(new URL(url).pathname) || [""])[0].toLowerCase();
  } catch {
    return "";
  }
}

// How a painting body would be copied, from what it says about itself.
// {mode: "hls" | "file"} or {mode: null, reason}.
function avCopyMode(body) {
  if (!body || !AV_TYPES.has(body.type)) return {mode: null, reason: "Not an audio or video canvas"};
  if (typeof body.id !== "string") return {mode: null, reason: "No media URL"};
  const format = String(body.format || "").toLowerCase();
  const extension = extensionOf(body.id);
  if (HLS_FORMATS.has(format) || extension === ".m3u8") return {mode: "hls"};
  if (format === "application/dash+xml" || extension === ".mpd") {
    return {mode: null, reason: "DASH streams aren't supported yet"};
  }
  if (PLAYABLE_FILE_FORMATS.has(format) || (!format && PLAYABLE_FILE_EXTENSIONS.has(extension))) {
    return {mode: "file"};
  }
  return {mode: null, reason: `Needs transcoding (${format || extension || "unknown format"})`};
}

// IIIF Auth, v1 or v2, anywhere in a service tree.
//
// This is checked BEFORE anything is fetched, and a success does not override
// it. The Auth spec allows a server to answer an unauthorised request with 200
// and a degraded substitute (a blurred image, a short clip) at the same URL, so
// a 200 does not prove we were given the real thing — copying it would publish
// the substitute as if it were the work.
function hasAuthService(resource) {
  const visit = (services) => {
    for (const service of Array.isArray(services) ? services : services ? [services] : []) {
      const type = String(service?.type || service?.["@type"] || "");
      const profile = String(service?.profile || "");
      if (/^Auth.*Service/.test(type) || profile.includes("iiif.io/api/auth/")) return true;
      if (visit(service?.service)) return true;
    }
    return false;
  };
  return visit(resource?.service);
}

function refusal(reason, {restricted = false} = {}) {
  return {ok: false, restricted, reason};
}

// One anonymous GET, classified. `credentials: "omit"` is the default in Node
// and a no-op here, but it states the rule where the request is made.
async function anonymousGet(url, fetchImpl, headers = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      credentials: "omit",
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {failure: refusal(`Couldn't reach the source (${error.message})`)};
  }
  if (response.status === 401 || response.status === 403) {
    return {failure: refusal("Restricted by the source", {restricted: true})};
  }
  if (!response.ok && response.status !== 206) {
    return {failure: refusal(`The source returned HTTP ${response.status}`)};
  }
  return {response};
}

// Walks the playlist tree — playlists only, never segments — so an encrypted
// or live rendition two levels down is refused now, rather than discovered
// halfway through a copy. A few small requests per stream.
async function inspectHls(masterUrl, fetchImpl) {
  const queue = [masterUrl];
  const seen = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    if (seen.size > MAX_PLAYLISTS) return refusal("The stream has too many playlists to copy");
    const {response, failure} = await anonymousGet(url, fetchImpl);
    if (failure) return failure;
    const text = await response.text();
    const analysis = analyzePlaylist(text);
    if (analysis.problems.length) return refusal(analysis.problems[0].message);
    // Relative references resolve against where the playlist actually came
    // from, which after a redirect is not where we asked.
    const base = response.url || url;
    for (const ref of analysis.refs) {
      if (ref.playlist) queue.push(new URL(ref.uri, base).toString());
    }
  }
  return {ok: true, mode: "hls"};
}

async function inspectFile(url, fetchImpl) {
  // A one-byte range rather than HEAD: plenty of media servers refuse HEAD,
  // and none refuse a range they would serve in full.
  const {response, failure} = await anonymousGet(url, fetchImpl, {Range: "bytes=0-0"});
  if (failure) return failure;
  await response.body?.cancel?.().catch(() => {});
  return {ok: true, mode: "file"};
}

// Can this canvas's media be copied? {ok, mode} or {ok: false, restricted, reason}.
async function inspectAvCanvas(canvas, {fetchImpl = fetch} = {}) {
  const body = paintingBody(canvas);
  if (hasAuthService(body) || hasAuthService(canvas)) {
    return refusal("Restricted by the source (IIIF Auth)", {restricted: true});
  }
  const {mode, reason} = avCopyMode(body);
  if (!mode) return refusal(reason);
  return mode === "hls" ? inspectHls(body.id, fetchImpl) : inspectFile(body.id, fetchImpl);
}

function canvasLabel(canvas, index) {
  const label = canvas?.label;
  const first = label && typeof label === "object" ? Object.values(label).flat()[0] : null;
  const bodyLabel = paintingBody(canvas)?.label;
  const fromBody = bodyLabel && typeof bodyLabel === "object" ? Object.values(bodyLabel).flat()[0] : null;
  return first || fromBody || `Canvas ${index + 1}`;
}

// Screen a manifest's canvases. Image canvases pass straight through; each
// audio/video canvas is inspected, and the ones we cannot host are removed
// BEFORE the manifest is written — the same place imageCanvasesOnly drops them
// on collection import — so a canvas pointing at someone else's streaming
// server never reaches S3, let alone published/.
//
// Returns the kept items, what was skipped and why, and how many A/V canvases
// will be copied, for the preview to say before the curator commits.
async function screenAvCanvases(items, {fetchImpl = fetch, concurrency = 6} = {}) {
  const list = Array.isArray(items) ? items : [];
  const verdicts = new Map();
  const avIndexes = list.map((canvas, index) => (isAvCanvas(canvas) ? index : -1)).filter((i) => i >= 0);
  let cursor = 0;
  const worker = async () => {
    while (cursor < avIndexes.length) {
      const index = avIndexes[cursor];
      cursor += 1;
      verdicts.set(index, await inspectAvCanvas(list[index], {fetchImpl}));
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, avIndexes.length)}, worker));

  const kept = [];
  const skipped = [];
  list.forEach((canvas, index) => {
    const verdict = verdicts.get(index);
    if (!verdict || verdict.ok) {
      kept.push(canvas);
      return;
    }
    skipped.push({
      index,
      label: canvasLabel(canvas, index),
      kind: paintingBody(canvas).type === "Video" ? "video" : "audio",
      reason: verdict.reason,
      restricted: verdict.restricted,
    });
  });
  const copied = [...verdicts.values()].filter((verdict) => verdict.ok).length;
  return {items: kept, skipped, av: {total: avIndexes.length, copied}};
}

// A thumbnail entry on OUR Image API service, fitted inside `box` — for a
// copied A/V poster and for a work's own copied thumbnail alike.
//
// The size is an exact width we compute, `{w},`, never a `!w,h` box. NUL's
// poster service answers its own advertised "!300,300" with 400 "Requested
// size requires upscaling" on a 320x240 frame, which is a downscale; asking
// for a width that is already within bounds leaves no room for that.
// `service` is kept, so a UI can crop a square from it the way the
// collections list already does.
function boxedThumbnail({service, width, height, box = 300}) {
  const scale = Math.min(1, box / width, box / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return {
    id: `${service.id}/full/${w},/0/default.jpg`,
    type: "Image",
    format: "image/jpeg",
    width: w,
    height: h,
    service: [service],
  };
}

module.exports = {
  boxedThumbnail,
  isAvCanvas,
  avCopyMode,
  hasAuthService,
  inspectAvCanvas,
  screenAvCanvases,
};
