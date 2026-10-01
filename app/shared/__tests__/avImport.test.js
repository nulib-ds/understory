const test = require("node:test");
const assert = require("node:assert/strict");

const {avCopyMode, hasAuthService, inspectAvCanvas, screenAvCanvases} = require("../avImport");

const STREAM = "https://streaming.example.edu/aa/bb/";
const MASTER = `${STREAM}Reel1.m3u8`;

function avCanvas({id = MASTER, type = "Sound", format = "application/x-mpegurl", service, label} = {}) {
  return {
    type: "Canvas",
    ...(label ? {label: {en: [label]}} : {}),
    items: [{items: [{motivation: "painting", body: {id, type, format, duration: 12, ...(service ? {service} : {})}}]}],
  };
}

function imageCanvas() {
  return {type: "Canvas", items: [{items: [{body: {id: "https://img/x/full/max/0/default.jpg", type: "Image"}}]}]};
}

// A stand-in for fetch keyed by URL. Anything not listed is a 404.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({url, options});
    const route = routes[url];
    if (!route) return {ok: false, status: 404, url, text: async () => ""};
    const status = route.status ?? 200;
    return {ok: status >= 200 && status < 300, status, url: route.url || url, text: async () => route.body || ""};
  };
  impl.calls = calls;
  return impl;
}

const master = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=327680", "quality-high/hls/Reel1.m3u8"].join("\n");
const media = ["#EXTM3U", "#EXT-X-TARGETDURATION:3", "#EXTINF:2.0,", "Reel1_00.ts", "#EXT-X-ENDLIST"].join("\n");

test("avCopyMode: HLS by format or extension, playable files as-is, the rest need transcoding", () => {
  assert.equal(avCopyMode(avCanvas().items[0].items[0].body).mode, "hls");
  assert.equal(avCopyMode({type: "Video", id: "https://x/a/master.m3u8"}).mode, "hls");
  assert.equal(avCopyMode({type: "Video", id: "https://x/a.mp4", format: "video/mp4"}).mode, "file");
  assert.equal(avCopyMode({type: "Sound", id: "https://x/a.mp3"}).mode, "file");
  assert.match(avCopyMode({type: "Video", id: "https://x/a.mpd"}).reason, /DASH/);
  assert.match(avCopyMode({type: "Sound", id: "https://x/a.wav", format: "audio/wav"}).reason, /transcoding/);
  assert.equal(avCopyMode({type: "Image", id: "https://x/a.jpg"}).mode, null);
});

test("hasAuthService finds IIIF Auth 1 and 2, including nested services", () => {
  assert.equal(hasAuthService({service: [{type: "AuthProbeService2", id: "x"}]}), true);
  assert.equal(hasAuthService({service: [{"@type": "AuthCookieService1", profile: "http://iiif.io/api/auth/1/login"}]}), true);
  assert.equal(hasAuthService({service: [{type: "ImageService3", service: [{type: "AuthAccessService2"}]}]}), true);
  assert.equal(hasAuthService({service: [{type: "ImageService3", profile: "level2"}]}), false);
  assert.equal(hasAuthService({}), false);
});

test("a public HLS stream is copyable, and screening fetches playlists, never segments", async () => {
  const fetchImpl = fakeFetch({
    [MASTER]: {body: master},
    [`${STREAM}quality-high/hls/Reel1.m3u8`]: {body: media},
  });
  assert.deepEqual(await inspectAvCanvas(avCanvas(), {fetchImpl}), {ok: true, mode: "hls"});
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.url),
    [MASTER, `${STREAM}quality-high/hls/Reel1.m3u8`],
  );
  // The request never carries credentials.
  assert.ok(fetchImpl.calls.every((call) => call.options.credentials === "omit"));
});

// NUL's Institution-only streams, as verified against the live API.
test("a 403 is reported as restricted, not as a failure to retry", async () => {
  const fetchImpl = fakeFetch({[MASTER]: {status: 403}});
  assert.deepEqual(await inspectAvCanvas(avCanvas(), {fetchImpl}), {
    ok: false,
    restricted: true,
    reason: "Restricted by the source",
  });
});

test("an advertised auth service refuses without fetching anything", async () => {
  const fetchImpl = fakeFetch({[MASTER]: {body: master}});
  const verdict = await inspectAvCanvas(avCanvas({service: [{type: "AuthProbeService2", id: "p"}]}), {fetchImpl});
  assert.equal(verdict.restricted, true);
  assert.equal(fetchImpl.calls.length, 0);
});

test("an encrypted rendition below the master is refused before any copying", async () => {
  const encrypted = ["#EXTM3U", '#EXT-X-KEY:METHOD=AES-128,URI="k"', "#EXTINF:2,", "a.ts", "#EXT-X-ENDLIST"].join("\n");
  const fetchImpl = fakeFetch({
    [MASTER]: {body: master},
    [`${STREAM}quality-high/hls/Reel1.m3u8`]: {body: encrypted},
  });
  const verdict = await inspectAvCanvas(avCanvas(), {fetchImpl});
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /encrypted/);
});

test("relative references resolve against where a redirect actually landed", async () => {
  const moved = "https://cdn.example.edu/zz/Reel1.m3u8";
  const fetchImpl = fakeFetch({
    [MASTER]: {body: master, url: moved},
    "https://cdn.example.edu/zz/quality-high/hls/Reel1.m3u8": {body: media},
  });
  assert.equal((await inspectAvCanvas(avCanvas(), {fetchImpl})).ok, true);
});

// The mixed shape of NUL's "Sandy and Jeanie audition": one Sound canvas, then
// images. Images pass through untouched; only the A/V canvas is inspected.
test("screenAvCanvases keeps images, keeps copyable A/V, and removes the rest with a reason", async () => {
  const restrictedUrl = `${STREAM}Reel2.m3u8`;
  const fetchImpl = fakeFetch({
    [MASTER]: {body: master},
    [`${STREAM}quality-high/hls/Reel1.m3u8`]: {body: media},
    [restrictedUrl]: {status: 403},
  });
  const items = [
    avCanvas({label: "Reel 1"}),
    imageCanvas(),
    avCanvas({id: restrictedUrl, label: "Reel 2"}),
    avCanvas({id: "https://x/a.wav", format: "audio/wav"}),
  ];
  const result = await screenAvCanvases(items, {fetchImpl});
  assert.deepEqual(result.items, [items[0], items[1]]);
  assert.deepEqual(result.av, {total: 3, copied: 1});
  assert.deepEqual(
    result.skipped.map(({index, label, kind, restricted}) => ({index, label, kind, restricted})),
    [
      {index: 2, label: "Reel 2", kind: "audio", restricted: true},
      {index: 3, label: "Canvas 4", kind: "audio", restricted: false},
    ],
  );
});

test("a manifest with no A/V makes no requests at all", async () => {
  const fetchImpl = fakeFetch({});
  const items = [imageCanvas(), imageCanvas()];
  const result = await screenAvCanvases(items, {fetchImpl});
  assert.deepEqual(result, {items, skipped: [], av: {total: 0, copied: 0}});
  assert.equal(fetchImpl.calls.length, 0);
});

const {boxedThumbnail} = require("../avImport");

test("boxedThumbnail asks for an exact width inside the box, never !w,h", () => {
  const service = {id: "https://images.example/iiif/2/image%2Fw%2F0-poster", type: "ImageService2"};
  // NUL's Bienen poster: 320x240, whose advertised !300,300 NUL itself refuses.
  assert.deepEqual(boxedThumbnail({service, width: 320, height: 240}), {
    id: `${service.id}/full/300,/0/default.jpg`,
    type: "Image",
    format: "image/jpeg",
    width: 300,
    height: 225,
    service: [service],
  });
  // Portrait: height is the limit, so the width shrinks to match.
  assert.equal(boxedThumbnail({service, width: 1080, height: 1920}).id, `${service.id}/full/169,/0/default.jpg`);
  // Already small: never upscaled.
  const small = boxedThumbnail({service, width: 200, height: 100});
  assert.equal(small.id, `${service.id}/full/200,/0/default.jpg`);
  assert.doesNotMatch(small.id, /!/);
});
