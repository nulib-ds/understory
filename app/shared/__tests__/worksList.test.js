const test = require("node:test");
const assert = require("node:assert/strict");

const {buildCollectionDocument, CONTENT_HASH_KEY} = require("../collection");
const {PUBLISHED} = require("../space");
const {listCollectionWorks, matchesFilter} = require("../worksList");

const BASE = "https://iiif.example";
const workingId = (id) => `${BASE}/working/presentation/manifest/${id}/manifest.json`;
const publishedId = (id) => `${BASE}/published/presentation/manifest/${id}/manifest.json`;

const working = (members) =>
  buildCollectionDocument({
    baseUrl: BASE,
    slug: "maps",
    label: "Maps",
    members: members.map(([id, label, contentHash, extra = {}]) => ({
      manifestId: workingId(id),
      label,
      contentHash,
      itemCount: 2,
      ...extra,
    })),
  });

// Built the way the publish run builds it: the builder, then the hash of the
// working bytes each published copy was made from.
const published = (members) => {
  const document = buildCollectionDocument({
    baseUrl: BASE,
    space: PUBLISHED,
    slug: "maps",
    label: "Maps",
    members: members.map(([id, label]) => ({manifestId: publishedId(id), label})),
  });
  document.items = document.items.map((item, i) => ({...item, [CONTENT_HASH_KEY]: members[i][2]}));
  return document;
};

test("each row's status is the publish diff: new, changed or published", () => {
  const result = listCollectionWorks({
    working: working([
      ["a", "Atlas", "h-a"],
      ["b", "Bay", "h-b-new"],
      ["c", "Coast", "h-c"],
    ]),
    published: published([
      ["a", "Atlas", "h-a"],
      ["b", "Bay", "h-b-old"],
    ]),
  });
  assert.deepEqual(
    result.works.map((w) => [w.identifier, w.syncState]),
    [["a", "published"], ["b", "changed"], ["c", "new"]],
  );
  assert.deepEqual(result.counts, {new: 1, changed: 1, published: 1});
  assert.equal(result.total, 3);
});

test("a never-published collection is all new, and needs no published leaf", () => {
  const result = listCollectionWorks({working: working([["a", "Atlas", "h"]]), published: null});
  assert.deepEqual(result.counts, {new: 1, changed: 0, published: 0});
});

// A member written before hashes were recorded has none. It must not read as
// published, or it would never be republished.
test("a member with no recorded hash counts as changed, not published", () => {
  const result = listCollectionWorks({
    working: working([["a", "Atlas", undefined]]),
    published: published([["a", "Atlas", "h"]]),
  });
  assert.equal(result.works[0].syncState, "changed");
});

test("rows carry what the table draws", () => {
  const [row] = listCollectionWorks({
    working: working([["a", "Atlas", "h", {thumbnailService: "https://img/a"}]]),
    published: null,
  }).works;
  assert.deepEqual(row, {
    identifier: "a",
    label: "Atlas",
    manifestUrl: workingId("a"),
    thumbnails: ["https://img/a"],
    itemCount: 2,
    syncState: "new",
  });
});

test("the filter narrows the rows and the total, but never the counts", () => {
  const result = listCollectionWorks({
    working: working([
      ["a", "Atlas of Chicago", "h"],
      ["b", "Bay charts", "h"],
      ["c", "Chicago river", "h"],
    ]),
    published: null,
    q: "chicago",
  });
  assert.deepEqual(result.works.map((w) => w.identifier), ["a", "c"], "still in label order");
  assert.equal(result.total, 2);
  assert.deepEqual(result.counts, {new: 3, changed: 0, published: 0}, "the publish summary is whole-collection");
});

test("paging slices the filtered rows", () => {
  const result = listCollectionWorks({
    working: working([
      ["a", "A", "h"],
      ["b", "B", "h"],
      ["c", "C", "h"],
    ]),
    published: null,
    from: 1,
    size: 1,
  });
  assert.deepEqual(result.works.map((w) => w.identifier), ["b"]);
  assert.equal(result.total, 3);
});

test("matching ignores case and accents, and wants every word", () => {
  assert.equal(matchesFilter("Müller Collection", "muller"), true);
  assert.equal(matchesFilter("Müller Collection", "COLLECTION müller"), true, "any order");
  assert.equal(matchesFilter("Müller Collection", "muller maps"), false, "every word must match");
  assert.equal(matchesFilter("Anything", "   "), true, "a blank filter matches everything");
});
