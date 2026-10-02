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
