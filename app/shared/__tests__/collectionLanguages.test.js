// A collection's language list (LANGUAGES_KEY): curator-set, stored on the
// collection's entry in the root register, and copied onto the leaf.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LANGUAGES_KEY,
  EXTENSION_NAMESPACE,
  CollectionNameError,
  sanitizeCollectionLanguages,
  collectionLanguages,
  buildCollectionDocument,
  buildRootCollectionDocument,
  rootCollectionSummaries,
  planReconciliation,
  normalizeContext,
} = require("../collection");

const BASE = "https://example-iiif.s3.us-east-1.amazonaws.com";
const manifestId = (id) => `${BASE}/presentation/manifest/${id}/manifest.json`;

test("the term is an absolute IRI in the extension namespace, never a compact one", () => {
  assert.equal(LANGUAGES_KEY, `${EXTENSION_NAMESPACE}languages`);
  assert.match(LANGUAGES_KEY, /^https:\/\//);
});

test("sanitizing keeps the order, trims, and drops case-insensitive repeats", () => {
  assert.deepEqual(sanitizeCollectionLanguages([" en ", "fr", "EN", "fr-CA", "ar-Latn"]), [
    "en",
    "fr",
    "fr-CA",
    "ar-Latn",
  ]);
  assert.deepEqual(sanitizeCollectionLanguages([]), []);
});

test("sanitizing refuses what is not a list of language tags", () => {
  for (const bad of ["en", null, {en: true}]) {
    assert.throws(() => sanitizeCollectionLanguages(bad), CollectionNameError);
  }
  for (const bad of [["none"], ["english"], [""], ["e"], ["en_US"], [42]]) {
    assert.throws(() => sanitizeCollectionLanguages(bad), CollectionNameError, String(bad));
  }
  assert.throws(
    () => sanitizeCollectionLanguages(Array.from({length: 21}, (_, i) => `x${String.fromCharCode(97 + (i % 26))}${i}`.slice(0, 3))),
    CollectionNameError,
  );
});

test("the root entry is the authoritative copy and round-trips through the summary", () => {
  const root = buildRootCollectionDocument({
    baseUrl: BASE,
    collections: [
      {slug: "masks", label: "Masks", thumbnail: null, itemCount: 3, languages: ["en", "fr"]},
      {slug: "maps", label: "Maps", thumbnail: null, itemCount: 0},
    ],
  });
  assert.deepEqual(root.items[0][LANGUAGES_KEY], ["en", "fr"]);
  assert.equal(LANGUAGES_KEY in root.items[1], false, "no list, no term");
  const [masks, maps] = rootCollectionSummaries(root);
  assert.deepEqual(masks.languages, ["en", "fr"]);
  assert.deepEqual(maps.languages, []);
});

test("the leaf carries a copy, and none when the collection has no list", () => {
  const leaf = buildCollectionDocument({baseUrl: BASE, slug: "masks", label: "Masks", members: [], languages: ["fr", "en"]});
  assert.deepEqual(leaf[LANGUAGES_KEY], ["fr", "en"]);
  assert.deepEqual(collectionLanguages(leaf), ["fr", "en"]);
  const bare = buildCollectionDocument({baseUrl: BASE, slug: "maps", label: "Maps", members: []});
  assert.equal(LANGUAGES_KEY in bare, false);
  assert.deepEqual(collectionLanguages(bare), []);
});

test("the @context stays the bare presentation string, which Clover can read", () => {
  const leaf = buildCollectionDocument({baseUrl: BASE, slug: "masks", label: "Masks", members: [], languages: ["en"]});
  assert.equal(typeof leaf["@context"], "string");
  assert.deepEqual(normalizeContext(leaf["@context"]), leaf["@context"]);
});

test("reading a hand-edited value drops what is not a tag rather than throwing", () => {
  assert.deepEqual(collectionLanguages({[LANGUAGES_KEY]: ["en", 7, "not a tag", "fr"]}), ["en", "fr"]);
  assert.deepEqual(collectionLanguages({[LANGUAGES_KEY]: "en"}), []);
  assert.deepEqual(collectionLanguages(undefined), []);
});

test("a save that rebuilds the leaf and the root keeps the collection's languages", () => {
  const root = buildRootCollectionDocument({
    baseUrl: BASE,
    collections: [{slug: "masks", label: "Masks", thumbnail: null, itemCount: 0, languages: ["en", "fr"]}],
  });
  // The leaf as stored before the list was set: the root is what decides.
  const existing = buildCollectionDocument({baseUrl: BASE, slug: "masks", label: "Masks", members: []});
  const plan = planReconciliation({
    baseUrl: BASE,
    member: {manifestId: manifestId("w1"), label: "Pantalone"},
    desired: [{slug: "masks", label: "Masks"}],
    root,
    leaves: {masks: existing},
  });
  assert.deepEqual(plan.leafWrites[0].document[LANGUAGES_KEY], ["en", "fr"]);
  assert.deepEqual(plan.rootNext.items[0][LANGUAGES_KEY], ["en", "fr"]);
  assert.deepEqual(plan.collections[0].languages, ["en", "fr"]);
});

test("a collection the root does not list yet keeps its own leaf's list", () => {
  const existing = buildCollectionDocument({baseUrl: BASE, slug: "masks", label: "Masks", members: [], languages: ["it"]});
  const plan = planReconciliation({
    baseUrl: BASE,
    member: {manifestId: manifestId("w1"), label: "Pantalone"},
    desired: [{slug: "masks", label: "Masks"}],
    root: buildRootCollectionDocument({baseUrl: BASE, collections: []}),
    leaves: {masks: existing},
  });
  assert.deepEqual(plan.leafWrites[0].document[LANGUAGES_KEY], ["it"]);
});
