// HLS playlists, for copying a source's stream verbatim (app/shared/avCopy.js).
//
// Pure — node:crypto only — so all of it is unit-testable.
//
// An HLS stream is a text playlist naming other files: a master playlist names
// one playlist per quality level, and each of those names its segments. To host
// a copy we fetch every file the tree names and write it under one folder, so
// the copy has to find EVERY reference, not just the obvious ones. Some are
// bare lines; others sit inside a tag's URI="…" attribute:
//
//   #EXT-X-MAP:URI="init.mp4"            fMP4 init segment — miss it, nothing plays
//   #EXT-X-MEDIA:…,URI="audio/en.m3u8"   separate audio/subtitle track — miss it, silence
//   #EXT-X-I-FRAME-STREAM-INF:…,URI="…"  trick-play playlist
//
// And some streams must be refused rather than copied (see analyzePlaylist).

const crypto = require("node:crypto");

const HLS_CONTENT_TYPE = "application/vnd.apple.mpegurl";

// Tags whose URI attribute names another file. MAP is media; the other two are
// playlists, and only ever appear in a master.
const URI_ATTRIBUTE_TAGS = new Set(["EXT-X-MAP", "EXT-X-MEDIA", "EXT-X-I-FRAME-STREAM-INF"]);
const MASTER_TAGS = new Set(["EXT-X-STREAM-INF", "EXT-X-MEDIA", "EXT-X-I-FRAME-STREAM-INF"]);

// KEY=value,KEY="quoted, value" — the attribute-list grammar of RFC 8216 §4.2.
function parseAttributeList(text) {
  const attributes = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = pattern.exec(text || ""))) {
    const value = match[2];
    attributes[match[1]] = value.startsWith('"') ? value.slice(1, -1) : value;
  }
  return attributes;
}

function splitTag(line) {
  const colon = line.indexOf(":");
  return colon === -1
    ? {tag: line.slice(1), rest: ""}
    : {tag: line.slice(1, colon), rest: line.slice(colon + 1)};
}

// What a playlist is, what it references, and why it cannot be copied (if it
// cannot). A playlist is either a master or a media playlist, never both
// (RFC 8216 §4.1), so every reference in a master is a playlist and every
// reference in a media playlist is a file to copy.
//
// Refused, each for a reason that copying cannot fix:
//   - encrypted: the key sits on their server, usually behind their auth, and
//     copying the key would be copying their protection away.
//   - live/unfinished (a media playlist with no EXT-X-ENDLIST): still being
//     written, so there is nothing finished to copy.
function analyzePlaylist(text) {
  const lines = String(text || "").split(/\r?\n/);
  const problems = [];
  if ((lines[0] || "").trim() !== "#EXTM3U") {
    return {kind: null, refs: [], problems: [{code: "not-hls", message: "Not an HLS playlist"}]};
  }
  const isMaster = lines.some((raw) => {
    const line = raw.trim();
    return line.startsWith("#") && MASTER_TAGS.has(splitTag(line).tag);
  });

  const refs = [];
  let ended = false;
  let encrypted = false;
  lines.forEach((raw, lineIndex) => {
    const line = raw.trim();
    if (!line) return;
    if (!line.startsWith("#")) {
      refs.push({uri: line, lineIndex, tag: null, playlist: isMaster});
      return;
    }
    const {tag, rest} = splitTag(line);
    if (tag === "EXT-X-ENDLIST") ended = true;
    if (tag === "EXT-X-KEY" || tag === "EXT-X-SESSION-KEY") {
      const method = parseAttributeList(rest).METHOD || "NONE";
      if (method !== "NONE") encrypted = true;
    }
    if (URI_ATTRIBUTE_TAGS.has(tag)) {
      const {URI} = parseAttributeList(rest);
      if (URI) refs.push({uri: URI, lineIndex, tag, playlist: tag !== "EXT-X-MAP"});
    }
  });

  if (encrypted) problems.push({code: "encrypted", message: "The stream is encrypted"});
  if (!isMaster && !ended) {
    problems.push({code: "live", message: "The stream is live or unfinished (no EXT-X-ENDLIST)"});
  }
  return {kind: isMaster ? "master" : "media", refs, problems};
}

// Replace each reference with mapUri(uri, ref). Everything else — tags,
// durations, byte ranges, comments — is kept byte for byte, so a playlist whose
// references map to themselves comes back unchanged.
function rewritePlaylist(text, mapUri) {
  const {refs} = analyzePlaylist(text);
  const lines = String(text || "").split(/\r?\n/);
  for (const ref of refs) {
    const replacement = mapUri(ref.uri, ref);
    if (ref.tag === null) {
      lines[ref.lineIndex] = lines[ref.lineIndex].replace(ref.uri, replacement);
    } else {
      lines[ref.lineIndex] = lines[ref.lineIndex].replace(`URI="${ref.uri}"`, `URI="${replacement}"`);
    }
  }
  return lines.join("\n");
}

// --- Where each copied file goes ---------------------------------------------

function withoutQuery(url) {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function directoryOf(url) {
  const clean = withoutQuery(url);
  return clean.slice(0, clean.lastIndexOf("/") + 1);
}

// Characters that survive the round trip S3 key -> CloudFront path -> S3 key
// untouched. A "%" would not: a key containing a literal "%20" is requested as
// "%2520", so anything outside this set is renamed instead.
const SAFE_PATH = /^[A-Za-z0-9._~\-/]+$/;

function isSafeRelativePath(path) {
  return (
    SAFE_PATH.test(path) &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

// A resolved source URL -> its path inside the copy's folder.
//
// Anything under the master playlist's directory keeps its relative path, so a
// normally-shaped stream copies to the same layout and its playlists need no
// changes. Anything else — another host, a path above the master, an
// unsafe character — is renamed under _ext/ by a hash of its URL, which is
// stable, so a retried copy writes the same keys. The query string is dropped
// either way: a signed CDN query means nothing once the file is ours.
function localPathFor(resolvedUrl, rootDirectory) {
  const clean = withoutQuery(resolvedUrl);
  if (clean.startsWith(rootDirectory)) {
    const rest = clean.slice(rootDirectory.length);
    if (isSafeRelativePath(rest)) return rest;
  }
  const extension = (/\.[A-Za-z0-9]{1,5}$/.exec(new URL(clean).pathname) || [""])[0].toLowerCase();
  const digest = crypto.createHash("sha256").update(clean).digest("hex").slice(0, 20);
  return `_ext/${digest}${extension}`;
}

// The reference to write into the playlist at `fromFile` so it finds `toFile`,
// both being paths inside the copy's folder.
function relativeReference(fromFile, toFile) {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  return [...Array(from.length - shared).fill(".."), ...to.slice(shared)].join("/");
}

// The master playlist's own name inside the copy.
function masterFileName(url) {
  const name = withoutQuery(url).split("/").pop() || "";
  return isSafeRelativePath(name) && /\.m3u8?$/i.test(name) ? name : "index.m3u8";
}

const CONTENT_TYPES = {
  ".m3u8": HLS_CONTENT_TYPE,
  ".m3u": HLS_CONTENT_TYPE,
  ".ts": "video/mp2t",
  ".aac": "audio/aac",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".mp3": "audio/mpeg",
  ".vtt": "text/vtt",
  ".webm": "video/webm",
};

function contentTypeFor(path) {
  const extension = (/\.[A-Za-z0-9]+$/.exec(path) || [""])[0].toLowerCase();
  return CONTENT_TYPES[extension] || "application/octet-stream";
}

module.exports = {
  HLS_CONTENT_TYPE,
  parseAttributeList,
  analyzePlaylist,
  rewritePlaylist,
  withoutQuery,
  directoryOf,
  localPathFor,
  relativeReference,
  masterFileName,
  contentTypeFor,
};
