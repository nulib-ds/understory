const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseAttributeList,
  analyzePlaylist,
  rewritePlaylist,
  directoryOf,
  localPathFor,
  relativeReference,
  masterFileName,
  contentTypeFor,
} = require("../hls");

// The exact shape NUL's streaming host serves (Bienen300k, inu-brkflk-am_13):
// a master naming two quality levels by relative path, each a plain TS list.
const NUL_MASTER = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=2293760",
  "quality-high/hls/Bienen300k.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=1179648",
  "quality-medium/hls/Bienen300k.m3u8",
  "",
].join("\n");

const NUL_MEDIA = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-ALLOW-CACHE:YES",
  "#EXT-X-TARGETDURATION:4",
  "#EXTINF:2.015078,",
  "Bienen300k00000.ts",
  "#EXTINF:3.937267,",
  "Bienen300k00001.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

const ROOT = "https://streaming.example.edu/88/79/";

test("parseAttributeList handles quoted values containing commas", () => {
  assert.deepEqual(parseAttributeList('TYPE=AUDIO,GROUP-ID="aud",NAME="English, US",URI="a/en.m3u8"'), {
    TYPE: "AUDIO",
    "GROUP-ID": "aud",
    NAME: "English, US",
    URI: "a/en.m3u8",
  });
});

test("a NUL master is a master whose every reference is a playlist", () => {
  const analysis = analyzePlaylist(NUL_MASTER);
  assert.equal(analysis.kind, "master");
  assert.deepEqual(analysis.problems, []);
  assert.deepEqual(
    analysis.refs.map((ref) => [ref.uri, ref.playlist]),
    [
      ["quality-high/hls/Bienen300k.m3u8", true],
      ["quality-medium/hls/Bienen300k.m3u8", true],
    ],
  );
});

test("a NUL media playlist lists its segments and is finished", () => {
  const analysis = analyzePlaylist(NUL_MEDIA);
  assert.equal(analysis.kind, "media");
  assert.deepEqual(analysis.problems, []);
  assert.deepEqual(analysis.refs.map((ref) => ref.uri), ["Bienen300k00000.ts", "Bienen300k00001.ts"]);
  assert.ok(analysis.refs.every((ref) => !ref.playlist));
});

// The references a line-by-line walk would miss. Each one missed is a copy
// that plays nothing, or plays silent.
test("references inside tag attributes are found", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud"',
    "video/720.m3u8",
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="video/iframes.m3u8"',
  ].join("\n");
  assert.deepEqual(
    analyzePlaylist(master).refs.map((ref) => [ref.uri, ref.playlist]),
    [
      ["audio/en.m3u8", true],
      ["video/720.m3u8", true],
      ["video/iframes.m3u8", true],
    ],
  );
  const fmp4 = ["#EXTM3U", '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:6,", "seg1.m4s", "#EXT-X-ENDLIST"].join("\n");
  assert.deepEqual(
    analyzePlaylist(fmp4).refs.map((ref) => [ref.uri, ref.playlist]),
    [
      ["init.mp4", false],
      ["seg1.m4s", false],
    ],
  );
});

test("encrypted and unfinished streams are refused; METHOD=NONE is not encryption", () => {
  const encrypted = ["#EXTM3U", '#EXT-X-KEY:METHOD=AES-128,URI="https://x/key"', "#EXTINF:6,", "a.ts", "#EXT-X-ENDLIST"];
  assert.equal(analyzePlaylist(encrypted.join("\n")).problems[0].code, "encrypted");
  const clear = ["#EXTM3U", "#EXT-X-KEY:METHOD=NONE", "#EXTINF:6,", "a.ts", "#EXT-X-ENDLIST"];
  assert.deepEqual(analyzePlaylist(clear.join("\n")).problems, []);
  const live = ["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXTINF:6,", "a.ts"];
  assert.equal(analyzePlaylist(live.join("\n")).problems[0].code, "live");
  assert.equal(analyzePlaylist("<html>").problems[0].code, "not-hls");
});

test("localPathFor keeps the source layout under the master, and renames the rest", () => {
  assert.equal(localPathFor(`${ROOT}quality-high/hls/Bienen300k.m3u8`, ROOT), "quality-high/hls/Bienen300k.m3u8");
  // A signed query means nothing once the file is ours.
  assert.equal(localPathFor(`${ROOT}a/seg1.ts?Signature=abc`, ROOT), "a/seg1.ts");
  const foreign = localPathFor("https://cdn.other.org/x/seg1.ts", ROOT);
  assert.match(foreign, /^_ext\/[0-9a-f]{20}\.ts$/);
  // Stable, so a retried copy writes the same key.
  assert.equal(localPathFor("https://cdn.other.org/x/seg1.ts", ROOT), foreign);
  // "%" would not survive S3 key -> CloudFront path -> S3 key.
  assert.match(localPathFor(`${ROOT}a%20b/seg.ts`, ROOT), /^_ext\//);
  assert.equal(directoryOf(`${ROOT}master.m3u8?x=1`), ROOT);
});

test("relativeReference finds a file from a playlist anywhere in the copy", () => {
  assert.equal(relativeReference("quality-high/hls/x.m3u8", "quality-high/hls/x00.ts"), "x00.ts");
  assert.equal(relativeReference("master.m3u8", "quality-high/hls/x.m3u8"), "quality-high/hls/x.m3u8");
  assert.equal(relativeReference("quality-high/hls/x.m3u8", "_ext/abc.ts"), "../../_ext/abc.ts");
});

// The property that makes a verbatim copy verbatim: for a normally-shaped
// stream, mapping every reference through localPathFor + relativeReference
// reproduces the source playlists byte for byte.
test("rewriting a NUL-shaped stream changes nothing", () => {
  const masterLocal = "Bienen300k.m3u8";
  const masterBase = `${ROOT}${masterLocal}`;
  const map = (fromLocal, fromUrl) => (uri) =>
    relativeReference(fromLocal, localPathFor(new URL(uri, fromUrl).toString(), ROOT));
  assert.equal(rewritePlaylist(NUL_MASTER, map(masterLocal, masterBase)), NUL_MASTER);
  const mediaLocal = "quality-high/hls/Bienen300k.m3u8";
  assert.equal(rewritePlaylist(NUL_MEDIA, map(mediaLocal, `${ROOT}${mediaLocal}`)), NUL_MEDIA);
});

test("rewriting repoints absolute and attribute references", () => {
  const media = ["#EXTM3U", '#EXT-X-MAP:URI="https://cdn.other.org/init.mp4"', "#EXTINF:6,", "https://cdn.other.org/s1.m4s", "#EXT-X-ENDLIST"].join("\n");
  const out = rewritePlaylist(media, (uri) => `local/${uri.split("/").pop()}`);
  assert.match(out, /#EXT-X-MAP:URI="local\/init\.mp4"/);
  assert.match(out, /\nlocal\/s1\.m4s\n/);
  assert.doesNotMatch(out, /cdn\.other\.org/);
});

test("masterFileName and contentTypeFor", () => {
  assert.equal(masterFileName(`${ROOT}Bienen300k.m3u8?token=1`), "Bienen300k.m3u8");
  assert.equal(masterFileName(`${ROOT}playlist`), "index.m3u8");
  assert.equal(contentTypeFor("a/b.ts"), "video/mp2t");
  assert.equal(contentTypeFor("x.m3u8"), "application/vnd.apple.mpegurl");
  assert.equal(contentTypeFor("x.bin"), "application/octet-stream");
});
