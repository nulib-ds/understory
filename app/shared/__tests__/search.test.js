const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SearchNameError,
  publishedIndexName,
  liveAliasName,
  stagedAliasName,
  isOwnIndexName,
  parsePublishedIndexName,
  PUBLISHED_INDEX_PROPERTIES,
  buildPublishedDocument,
  MAX_QUERY_LENGTH,
  buildPublishedSearch,
  publishedSearchResults,
  publicSearchUrl,
  publicSearchSlug,
  publicSearchInvalidationPath,
  publicSearchResults,
} = require("../search");

const PREFIX = "kdid-dev";

test("index and alias names", () => {
  assert.equal(publishedIndexName(PREFIX, "eis", "k3f9a1"), "kdid-dev.eis._pub.k3f9a1");
  assert.equal(liveAliasName(PREFIX, "eis"), "kdid-dev.eis");
  assert.equal(stagedAliasName(PREFIX, "eis"), "kdid-dev.eis._staged");
});

// The reason the separator is "." and not "-". A slug is [a-z0-9-]+, so with a
// hyphen these two names would be the same string, and one collection's alias
// would silently be another's staged alias.
test('"." separates the parts because a hyphen would collide', () => {
  assert.notEqual(stagedAliasName(PREFIX, "my-coll"), liveAliasName(PREFIX, "my-coll-staged"));
  assert.equal(stagedAliasName(PREFIX, "my-coll"), "kdid-dev.my-coll._staged");
  assert.equal(liveAliasName(PREFIX, "my-coll-staged"), "kdid-dev.my-coll-staged");
  assert.notEqual(stagedAliasName(PREFIX, "eis"), liveAliasName(PREFIX, "eis"));
});

test("isOwnIndexName keeps GC off other stacks on the shared domain", () => {
  assert.equal(isOwnIndexName(PREFIX, liveAliasName(PREFIX, "eis")), true);
  assert.equal(isOwnIndexName(PREFIX, publishedIndexName(PREFIX, "eis", "k1")), true);
  assert.equal(isOwnIndexName(PREFIX, "other-stack.eis._pub.k1"), false);
  assert.equal(isOwnIndexName(PREFIX, ""), false);
});

test("names are validated rather than silently malformed", () => {
  // OpenSearch index names must be lowercase, and a leading dot is reserved.
  assert.throws(() => liveAliasName("KDID-Dev", "eis"), SearchNameError);
  assert.throws(() => liveAliasName(".hidden", "eis"), SearchNameError);
  assert.throws(() => liveAliasName("", "eis"), SearchNameError);
  assert.throws(() => liveAliasName(PREFIX, "Not A Slug"), SearchNameError);
  assert.throws(() => publishedIndexName(PREFIX, "eis", "has.dot"), SearchNameError);
});

test("parsePublishedIndexName round-trips, and rejects everything else", () => {
  const name = publishedIndexName(PREFIX, "eis", "k3f9a1");
  assert.deepEqual(parsePublishedIndexName(PREFIX, name), {slug: "eis", runId: "k3f9a1"});
  // A stack deployed before the working index was retired still has one.
  assert.equal(parsePublishedIndexName(PREFIX, "kdid-dev._working"), null);
  assert.equal(parsePublishedIndexName(PREFIX, liveAliasName(PREFIX, "eis")), null);
  assert.equal(parsePublishedIndexName(PREFIX, stagedAliasName(PREFIX, "eis")), null);
  // Another stack's index on the shared domain is not ours to garbage-collect.
  assert.equal(parsePublishedIndexName(PREFIX, "other-stack.eis.pub.k3f9a1"), null);
  assert.equal(parsePublishedIndexName(PREFIX, ""), null);
});

// What a downstream site reads. It must not learn anything about how this app
// works — no workId, no sync state, no collection field.
test("the published document is deliberately smaller", () => {
  const doc = buildPublishedDocument({
    manifestUrl: "https://b/published/presentation/manifest/abc/manifest.json",
    label: "Aerial Survey",
    thumbnails: ["https://img/1"],
    itemCount: 3,
  });
  assert.deepEqual(Object.keys(doc).sort(), ["itemCount", "manifestId", "thumbnails", "title"]);
  assert.match(doc.manifestId, /\/published\//);
  for (const field of ["workId", "syncState", "contentHash", "collection", "importing"]) {
    assert.equal(field in doc, false, `${field} is this app's business, not a consumer's`);
  }
});

test("mappings: titles are searched, and nothing about this app is mapped", () => {
  assert.equal(PUBLISHED_INDEX_PROPERTIES.title.type, "text");
  for (const field of ["collection", "syncState", "contentHash", "workId", "importing"]) {
    assert.equal(PUBLISHED_INDEX_PROPERTIES[field], undefined, field);
  }
});

// The browser sends a string, never query DSL: the route can only ask this.
test("an empty search lists everything alphabetically; a term searches titles", () => {
  const all = buildPublishedSearch({});
  assert.deepEqual(all.query, {match_all: {}});
  assert.deepEqual(all.sort, [{"title.keyword": "asc"}]);
  assert.equal(all.track_total_hits, true, "the total is the document count");

  const some = buildPublishedSearch({q: "  masks "});
  assert.deepEqual(some.query, {match: {title: {query: "masks", fuzziness: "AUTO"}}});
  assert.equal("sort" in some, false, "relevance order when searching");
});

test("paging is clamped, whatever the query string says", () => {
  assert.equal(buildPublishedSearch({size: "5000"}).size, 100);
  assert.equal(buildPublishedSearch({size: "0"}).size, 50, "zero falls back to the default");
  assert.equal(buildPublishedSearch({size: "nope"}).size, 50);
  assert.equal(buildPublishedSearch({from: "-4"}).from, 0);
  // Past the result window OpenSearch errors rather than returning nothing.
  assert.equal(buildPublishedSearch({from: "999999", size: "100"}).from, 9900);
  assert.equal(buildPublishedSearch({from: "999999"}).from, 9950);
});

test("an over-long query is cut, not refused", () => {
  const long = "a".repeat(MAX_QUERY_LENGTH * 5);
  assert.equal(buildPublishedSearch({q: long}).query.match.title.query.length, MAX_QUERY_LENGTH);
});

test("search hits come back as rows keyed by work id", () => {
  const {total, hits} = publishedSearchResults({
    hits: {
      total: {value: 12},
      hits: [{_id: "w1", _score: 1.5, _source: {manifestId: "m", title: "Masks", thumbnails: ["t"], itemCount: 3}}],
    },
  });
  assert.equal(total, 12);
  assert.deepEqual(hits, [{workId: "w1", manifestId: "m", title: "Masks", thumbnails: ["t"], itemCount: 3, score: 1.5}]);
});

test("no index yet reads as no results", () => {
  assert.deepEqual(publishedSearchResults(null), {total: 0, hits: []});
});

// --- the public route ---

test("the public search address sits beside the two spaces", () => {
  assert.equal(publicSearchUrl("https://iiif.example.org/", "eis"), "https://iiif.example.org/search/eis");
  assert.equal(publicSearchUrl("https://iiif.example.org", "eis"), "https://iiif.example.org/search/eis");
  assert.throws(() => publicSearchUrl("https://iiif.example.org", "Not A Slug"), SearchNameError);
});

test("only /search/{slug} names a collection", () => {
  assert.equal(publicSearchSlug("/search/eis"), "eis");
  assert.equal(publicSearchSlug("/search/my-coll/"), "my-coll");
  for (const path of ["/", "/search", "/search/", "/search/eis/extra", "/other/eis", "", null]) {
    assert.equal(publicSearchSlug(path), null, String(path));
  }
});

// The slug ends up inside an index expression. Each of these would make
// OpenSearch search something other than one collection's live alias.
test("a slug that would widen the index expression is refused", () => {
  for (const slug of ["*", "eis,other", "eis*", "_all", "eis._staged", "EIS", "%2A", "eis%2Cother", "%E0%A4%A"]) {
    assert.equal(publicSearchSlug(`/search/${slug}`), null, slug);
  }
});

test("the flip invalidates every cached variant of one collection's search", () => {
  assert.equal(publicSearchInvalidationPath("eis"), "/search/eis*");
  assert.throws(() => publicSearchInvalidationPath("*"), SearchNameError);
});

test("the public response is our shape, without work ids or scores", () => {
  const body = publicSearchResults(
    {
      hits: {
        total: {value: 12},
        hits: [{_id: "w1", _score: 1.5, _source: {manifestId: "m", title: "Masks", thumbnails: ["t"], itemCount: 3}}],
      },
    },
    {q: "masks", from: 0, size: 50},
  );
  assert.deepEqual(body, {
    q: "masks",
    from: 0,
    size: 50,
    total: 12,
    hits: [{manifestId: "m", title: "Masks", thumbnails: ["t"], itemCount: 3}],
  });
});
