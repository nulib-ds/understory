// The search index: names, mappings and document shapes.
//
// Pure — no AWS SDK, no IO. The signed HTTP client lives in
// app/shared/opensearch.js; everything here is a function of its arguments so
// the naming rules and both document shapes are unit-testable.
//
// Topology. Only the PUBLISHED side has indexes: one per collection per publish
// run, behind a stable alias the downstream site points at:
//
//   {prefix}.{slug}._pub.{runId}   one run's frozen output
//   {prefix}.{slug}                alias -> whichever pub index is live
//   {prefix}.{slug}._staged        alias -> the candidate awaiting its flip
//
// Per collection because that is what makes the alias flip atomic for one
// collection without touching another's.
//
// There used to be a working index too, {prefix}._working, behind the admin
// works list. That list is served from the collection documents now
// (worksList.js), so curators browsing never touch OpenSearch at all. A stack
// deployed before that still has one; nothing reads or writes it.

const {collectionSlugPattern} = require("./collection");

// "." separates the parts, not "-": a slug is [a-z0-9-]+, so with a hyphen the
// staged alias of `my-coll` and the live alias of `my-coll-staged` would be
// the same string.
//
// Every reserved segment also starts with "_", which a slug cannot contain, and
// the segment counts differ, so no slug can ever be read as a reserved word.
// That mattered most for the working index, `{prefix}._working`, which without
// the "_" was also the live alias of a collection named "Working". With it gone
// the counts alone would do, but these names are live aliases a consuming site
// points at, so they do not change. OpenSearch allows "_" inside an index name;
// only a LEADING "_", "-", "+" or "." is reserved, and the prefix is always a
// real name.
//
//   {prefix}.{slug}                2 segments, second is a slug
//   {prefix}.{slug}._staged        3
//   {prefix}.{slug}._pub.{runId}   4
const SEP = ".";
const PUBLISHED_INFIX = "_pub";
const STAGED_SUFFIX = "_staged";

const indexPrefixPattern = /^[a-z0-9][a-z0-9_-]*$/;
// A run id only has to be unique and sortable. Timestamps alone are not: two
// runs in the same second would collide, and index creation treats "already
// exists" as success, so the second run would quietly write into the first
// one's candidate.
const runIdPattern = /^[a-z0-9]+$/;

class SearchNameError extends Error {}

function assertPrefix(prefix) {
  if (!indexPrefixPattern.test(prefix || "")) {
    throw new SearchNameError(
      `Search index prefix must be lowercase letters, digits, "_" or "-", and start with a letter or digit: ${prefix}`,
    );
  }
  return prefix;
}

function assertSlug(slug) {
  if (!collectionSlugPattern.test(slug || "")) {
    throw new SearchNameError(`Not a collection slug: ${slug}`);
  }
  return slug;
}

function assertRunId(runId) {
  if (!runIdPattern.test(runId || "")) {
    throw new SearchNameError(`Not a run id: ${runId}`);
  }
  return runId;
}

function publishedIndexName(prefix, slug, runId) {
  return [assertPrefix(prefix), assertSlug(slug), PUBLISHED_INFIX, assertRunId(runId)].join(SEP);
}


// True only for a name this stack owns, so garbage collection on the shared
// domain can never touch another stack's index.
function isOwnIndexName(prefix, name) {
  return String(name || "").startsWith(`${prefix}${SEP}`);
}
// What a downstream site points at.
function liveAliasName(prefix, slug) {
  return [assertPrefix(prefix), assertSlug(slug)].join(SEP);
}

// What the asset publish points at its candidate, so "is something staged?" is
// one alias read rather than a guess from index names — which stops being a
// total order the moment two candidates can exist.
function stagedAliasName(prefix, slug) {
  return [assertPrefix(prefix), assertSlug(slug), STAGED_SUFFIX].join(SEP);
}

// Reads a published index name back apart, or null if it is not one. Used to
// garbage-collect candidates that no alias points at.
function parsePublishedIndexName(prefix, name) {
  const parts = String(name || "").split(SEP);
  if (parts.length !== 4) return null;
  const [candidatePrefix, slug, infix, runId] = parts;
  if (candidatePrefix !== prefix || infix !== PUBLISHED_INFIX) return null;
  if (!collectionSlugPattern.test(slug) || !runIdPattern.test(runId)) return null;
  return {slug, runId};
}

// --- documents -------------------------------------------------------------

// What a downstream site reads, so it carries no field that is about how THIS
// app works: no work id, no sync state, no collection. `_id` is the work id,
// which is never a field. thumbnails is there because a site rendering a result
// list would otherwise have to fetch every manifest to draw it.
const PUBLISHED_INDEX_PROPERTIES = {
  title: {type: "text", fields: {keyword: {type: "keyword", ignore_above: 512}}},
  manifestId: {type: "keyword"},
  thumbnails: {type: "keyword", index: false},
  itemCount: {type: "integer"},
};

function buildPublishedDocument({manifestUrl, label, thumbnails = [], itemCount = 0}) {
  return {
    manifestId: manifestUrl,
    title: label || "",
    thumbnails,
    itemCount,
  };
}

// GET /collections/{slug}/search, as a query against the live alias. Built here
// from a plain string rather than accepting query DSL from the browser, so the
// route can only ever ask the one question it is for. Titles are the only
// searchable field a published document has.
//
// Unfiltered, it lists everything alphabetically; filtered, by relevance.
const MAX_SEARCH_SIZE = 100;

function buildPublishedSearch({q = "", from = 0, size = 50} = {}) {
  const term = String(q || "").trim();
  return {
    from: Math.max(0, Number(from) || 0),
    size: Math.min(Math.max(1, Number(size) || 50), MAX_SEARCH_SIZE),
    track_total_hits: true,
    query: term ? {match: {title: {query: term, fuzziness: "AUTO"}}} : {match_all: {}},
    ...(term ? {} : {sort: [{"title.keyword": "asc"}]}),
  };
}

// A search response back into rows. `_id` is the work id (the publish run
// indexes each document under it), which is what lets a row link to its work.
function publishedSearchResults(response) {
  const hits = response?.hits?.hits || [];
  return {
    total: response?.hits?.total?.value ?? hits.length,
    hits: hits.map((hit) => ({
      workId: hit._id,
      manifestId: hit._source?.manifestId || "",
      title: hit._source?.title || "",
      thumbnails: hit._source?.thumbnails || [],
      itemCount: hit._source?.itemCount ?? 0,
      score: hit._score ?? null,
    })),
  };
}

module.exports = {
  SEP,
  SearchNameError,
  indexPrefixPattern,
  runIdPattern,
  publishedIndexName,
  liveAliasName,
  stagedAliasName,
  isOwnIndexName,
  parsePublishedIndexName,
  PUBLISHED_INDEX_PROPERTIES,
  buildPublishedDocument,
  buildPublishedSearch,
  publishedSearchResults,
};
