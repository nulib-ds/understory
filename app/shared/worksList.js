// The collection works list, from the collection's two leaf documents alone.
//
// Pure — no AWS SDK, no IO — so the list, its status column and its filter are
// all unit-testable. The route that serves it is GET /collections/{slug}/works
// in app/aws/lambdas/manifest/collections.js.
//
// This used to be a query against a working search index, maintained
// write-through on every save. The working leaf already holds every member in
// display order, S3 reads see the latest write, and each member now carries its
// own content hash — so the leaves answer everything the index did, a save
// shows up on the very next read, and OpenSearch stays asleep while curators
// browse. See AGENTS.md, "The works list".

const {
  CONTENT_HASH_KEY,
  ITEM_COUNT_KEY,
  THUMBNAIL_SERVICE_KEY,
  membersOf,
  workIdFromManifestUrl,
} = require("./collection");
const {extractLabel} = require("./language");
const {planPublish} = require("./publish");

const SYNC_NEW = "new";
const SYNC_CHANGED = "changed";
const SYNC_PUBLISHED = "published";

// workId -> sync state, by the same diff a publish run makes. Reusing
// planPublish is the point: the badge on a row and what pressing Publish would
// do to that row cannot disagree, because they are one computation.
function syncStates({workingMembers, publishedMembers}) {
  const plan = planPublish({workingMembers, publishedMembers});
  const states = new Map();
  for (const member of plan.adds) states.set(member.workId, SYNC_NEW);
  for (const member of plan.changes) states.set(member.workId, SYNC_CHANGED);
  for (const member of plan.unchanged) states.set(member.workId, SYNC_PUBLISHED);
  return states;
}

// Case- and accent-insensitive, so "Muller" finds "Müller" and "SKETCH" finds
// "sketch". NFKD splits a letter from its combining marks, which are dropped.
function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

// Every word of the filter must appear somewhere in the label, in any order.
// No typo tolerance: the index's `fuzziness: AUTO` forgave one, and this does
// not — a deliberate trade for not needing a search engine to list a page.
function matchesFilter(label, q) {
  const words = normalizeForMatch(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = normalizeForMatch(label);
  return words.every((word) => haystack.includes(word));
}

// One page of the works list, the counts for the whole collection, and the
// filtered total — the response shape the index-backed route returned, so the
// UI is unchanged.
//
//   working    the working leaf document (or null)
//   published  the published leaf document (or null: never published)
//
// Rows stay in the leaf's own order (label, then id — sortMembers) whether or
// not a filter is applied.
function listCollectionWorks({working, published, q = "", from = 0, size = 50}) {
  const items = membersOf(working);
  const rows = items
    .map((item) => ({item, workId: workIdFromManifestUrl(item.id)}))
    .filter((row) => row.workId);

  const states = syncStates({
    workingMembers: rows.map(({item, workId}) => ({workId, contentHash: item[CONTENT_HASH_KEY]})),
    publishedMembers: membersOf(published)
      .map((item) => ({workId: workIdFromManifestUrl(item.id), [CONTENT_HASH_KEY]: item[CONTENT_HASH_KEY]}))
      .filter((member) => member.workId),
  });

  const counts = {new: 0, changed: 0, published: 0};
  const works = rows.map(({item, workId}) => {
    const syncState = states.get(workId) || SYNC_CHANGED;
    counts[syncState] += 1;
    const service = item[THUMBNAIL_SERVICE_KEY];
    return {
      identifier: workId,
      label: extractLabel(item.label),
      manifestUrl: item.id,
      thumbnails: typeof service === "string" && service ? [service] : [],
      itemCount: Number.isInteger(item[ITEM_COUNT_KEY]) ? item[ITEM_COUNT_KEY] : 0,
      syncState,
    };
  });

  const matching = works.filter((work) => matchesFilter(work.label, q));
  const start = Math.max(0, from);
  return {
    total: matching.length,
    works: matching.slice(start, start + Math.max(0, size)),
    counts,
  };
}

module.exports = {
  SYNC_NEW,
  SYNC_CHANGED,
  SYNC_PUBLISHED,
  syncStates,
  normalizeForMatch,
  matchesFilter,
  listCollectionWorks,
};
