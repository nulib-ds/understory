// Publishing: the transform that turns a working IIIF document into its
// published twin, and the diff that decides what a run has to do.
//
// Pure — node:crypto only, no AWS SDK — so all of it is unit-testable. The IO
// lives in app/aws/lambdas/publish/.
//
// Publish is a rewrite, not a copy. Each space's documents describe their own
// URLs, so a published manifest is retrievable at its own `id`, and so is the
// working draft. The cost is that S3 ETags are useless for "has this changed?"
// — the bytes always differ — which is why we hash and record it ourselves.

const crypto = require("node:crypto");

// An absolute IRI for the same reason MANAGED_KEY is one: a compact IRI would
// need a prefix declared in @context, and an object in @context breaks Clover.
const CONTENT_HASH_KEY = "https://nulib-labs.github.io/static-iiif/ns#contentHash";

// sha256 of the exact bytes stored, never of a re-serialization. There is no
// canonical JSON here: applyCollections reorders keys as a side effect, so
// hashing a round trip would report changes that are not changes.
function contentHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// A self-reference is any string starting with the space's base, at a path
// boundary. The boundary matters: a bare startsWith would also rewrite
// `…/working-notes/…`, which is the same class of bug as the index-name
// separator.
function isSelfReference(value, from) {
  return typeof value === "string" && (value === from || value.startsWith(`${from}/`));
}

// Walk every STRING VALUE, at any depth — not just `id` keys.
//
// That distinction is load-bearing. `Annotation.target` is a bare string
// (ui/src/lib/canvasAssets.js), so an id-key walker would leave every
// annotation pointing at a canvas URL that does not exist in the published
// space: blank canvases in Clover, and no error anywhere.
//
// What it must NOT touch:
//   - Image API service ids. IMAGE_API_BASE_URL is a CloudFront host, entirely
//     distinct from the S3 bucket origin, so they cannot match by construction.
//   - A third-party partOf kept as provenance — different host, same reason.
//   - @context. Safe today because the extension namespace is on a different
//     host, but a walker that rewrites arbitrary values is one namespace change
//     away from breaking compact-IRI expansion, so it is skipped explicitly.
// `strip` removes keys anywhere in the tree. It exists for our own bookkeeping
// terms, which are meaningful in `working/` and noise in `published/`:
// MANAGED_KEY tells the manifest API which partOf entries are its own rather
// than the source institution's provenance, and nothing reads it back out of a
// published document.
//
// It is passed per-call rather than applied to every extension term, because
// one of them must survive: the published collection's items carry
// CONTENT_HASH_KEY, and planPublish compares against exactly that.
function rewriteUrls(node, {from, to, strip = []}, state = {replacements: 0}) {
  if (typeof node === "string") {
    if (isSelfReference(node, from)) {
      state.replacements += 1;
      return `${to}${node.slice(from.length)}`;
    }
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((entry) => rewriteUrls(entry, {from, to, strip}, state));
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (strip.includes(key)) continue;
      out[key] = key === "@context" ? value : rewriteUrls(value, {from, to, strip}, state);
    }
    return out;
  }
  return node;
}

// Returns the published document and how many URLs moved. Zero is a bug, not a
// no-op: a manifest whose id does not sit under the working base is a hand
// edit, a base-URL change, or an already-published document fed back in.
function publishDocument(document, {from, to, strip = []}) {
  const state = {replacements: 0};
  const published = rewriteUrls(document, {from, to, strip}, state);
  return {document: published, replacements: state.replacements};
}

// A work still pointing at someone else's Image API has not been imported —
// publishing it republishes a third-party hotlink. Not fatal, but the run
// should say so.
function externalImageServices(manifest, imageApiBase) {
  const found = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const service of node.service || []) {
      if (service?.id && imageApiBase && !service.id.startsWith(imageApiBase)) {
        found.add(service.id);
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(manifest);
  return [...found];
}

// What a run has to do, from the two collection documents alone.
//
// `published` is the record of what is live — its member entries carry the
// hash of the working bytes each was made from — so this is a comparison of
// durable artifacts. A diff journal written on every save was the alternative
// and was rejected: a journal drifts the moment a write half-fails or a run
// dies, and nothing ever repairs it.
function planPublish({workingMembers = [], publishedMembers = []}) {
  const publishedByUrl = new Map(
    publishedMembers.map((member) => [member.workId, member[CONTENT_HASH_KEY] || null]),
  );
  const adds = [];
  const changes = [];
  const unchanged = [];
  for (const member of workingMembers) {
    if (!publishedByUrl.has(member.workId)) adds.push(member);
    else if (publishedByUrl.get(member.workId) !== member.contentHash) changes.push(member);
    else unchanged.push(member);
  }
  const workingIds = new Set(workingMembers.map((member) => member.workId));
  const removes = publishedMembers.filter((member) => !workingIds.has(member.workId));
  return {adds, changes, unchanged, removes, total: workingMembers.length};
}

// The alias moves in ONE multi-action _aliases call, which is atomic on AWS
// OpenSearch Service: a reader never sees the alias on neither index or on
// both. Nothing is deleted here — garbage collection happens at the start of
// the next run, so a flip is trivially safe to retry and can never remove an
// index a concurrent run is still writing into.
function aliasFlipActions({index, liveAlias, stagedAlias, previousIndex}) {
  const actions = [];
  if (previousIndex && previousIndex !== index) {
    actions.push({remove: {index: previousIndex, alias: liveAlias}});
  }
  actions.push({add: {index, alias: liveAlias}});
  actions.push({remove: {index, alias: stagedAlias}});
  return actions;
}

module.exports = {
  CONTENT_HASH_KEY,
  contentHash,
  isSelfReference,
  rewriteUrls,
  publishDocument,
  externalImageServices,
  planPublish,
  aliasFlipActions,
};
