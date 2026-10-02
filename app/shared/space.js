// Working and published are two parallel spaces in the IIIF bucket. Everything
// the admin edits lives under `working/`; publishing transforms it into
// `published/`, which is what a downstream site consumes.
//
// Both spaces are self-consistent IIIF: a document under `working/` links only
// to other `working/` documents, and the same for `published/`. That is why
// publishing is a URL-rewriting transform rather than a copy — see
// app/shared/publish.js.
//
// Pure: no AWS SDK, so both manifest.js (which loads the SDK) and collection.js
// (which must not) can depend on it.

const WORKING = "working";
const PUBLISHED = "published";
const SPACES = [WORKING, PUBLISHED];

// Operational objects that are not part of either space — import status,
// publish plans and run status. Deliberately outside `presentation/` so a
// publish can treat `working/presentation/**` as "everything a site needs"
// without filtering, and outside the public bucket policy.
const INTERNAL_PREFIX = "internal";

// One work's asset-import progress. Here rather than in importAssets.js because
// the publish run reads it too, to hold back a work that is still importing.
function importStatusKey(identifier) {
  return `${INTERNAL_PREFIX}/import-status/${identifier}.json`;
}

// A copy of which index each of a collection's two search aliases names
// ({liveIndex, stagedIndex}), so showing the publish panel never has to ask
// OpenSearch, and so never wakes a scaled-to-zero collection or waits out its
// cold start. Written only by the two things that move an alias, from what they
// just read or did there: the publish run's Finalize, and the flip route.
// OpenSearch stays the truth: the flip reads it, never this, before acting.
function aliasStateKey(slug) {
  return `${INTERNAL_PREFIX}/publish/${slug}/aliases.json`;
}

class SpaceError extends Error {}

function assertSpace(space) {
  if (!SPACES.includes(space)) {
    throw new SpaceError(`Unknown space: ${space}`);
  }
  return space;
}

// `working/presentation/manifest/abc/manifest.json` from the space and the
// space-relative key.
function spaceKey(space, key) {
  return `${assertSpace(space)}/${key}`;
}

// The URL prefix every self-reference in a document of this space starts with.
// The boundary matters: a bare startsWith(base) would also match
// `…/working-notes/…`, so callers compare against this or this plus "/".
function spaceBase(baseUrl, space) {
  return `${(baseUrl || "").replace(/\/$/, "")}/${assertSpace(space)}`;
}

module.exports = {
  WORKING,
  PUBLISHED,
  SPACES,
  INTERNAL_PREFIX,
  importStatusKey,
  aliasStateKey,
  SpaceError,
  assertSpace,
  spaceKey,
  spaceBase,
};
