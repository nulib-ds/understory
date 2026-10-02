const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ROOT_COLLECTION_SLUG,
  buildCollectionDocument,
  buildRootCollectionDocument,
  createRootCollectionTemplate,
  planReconciliation,
  canonicalizeCollectionLabels,
  serializeCollection,
  manifestThumbnail,
} = require("../collection");

const BASE = "https://example-iiif.s3.us-east-1.amazonaws.com";
const manifestId = (id) => `${BASE}/presentation/manifest/${id}/manifest.json`;

const THUMB = [{id: "https://img/pindy", type: "Image", format: "image/jpeg"}];

const member = (id, label, thumbnail = null) => ({manifestId: manifestId(id), label, thumbnail});

// A leaf as it would have been stored by a previous reconciliation.
const leaf = (slug, label, members) =>
  buildCollectionDocument({baseUrl: BASE, slug, label, members});

const rootWith = (collections) => buildRootCollectionDocument({baseUrl: BASE, collections});

const slugsOf = (writes) => writes.map((write) => write.slug);

test("adds a work to a brand-new collection", () => {
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("a", "Pindy", THUMB),
    desired: [{slug: "campus-maps", label: "Campus Maps"}],
    root: createRootCollectionTemplate({baseUrl: BASE}),
    leaves: {"campus-maps": null},
  });

  assert.deepEqual(slugsOf(plan.leafWrites), ["campus-maps"]);
  assert.deepEqual(plan.leafDeletes, []);

  const [write] = plan.leafWrites;
  assert.equal(write.key, "working/presentation/collection/campus-maps/collection.json");
  assert.deepEqual(write.document.items.map((item) => item.id), [manifestId("a")]);
  assert.deepEqual(write.document.thumbnail, THUMB, "leaf borrows the member's thumbnail");

  assert.equal(plan.rootChanged, true);
  assert.deepEqual(plan.collections, [
    {slug: "campus-maps", label: "Campus Maps", thumbnail: THUMB, itemCount: 1},
  ]);
});

test("adds a work to a collection that already has members", () => {
  const existing = leaf("campus-maps", "Campus Maps", [member("a", "Aardvark")]);
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("b", "Bison"),
    desired: [{slug: "campus-maps", label: "Campus Maps"}],
    root: rootWith([{slug: "campus-maps", label: "Campus Maps", thumbnail: null, itemCount: 1}]),
    leaves: {"campus-maps": existing},
  });

  assert.deepEqual(plan.leafWrites[0].document.items.map((item) => item.id), [
    manifestId("a"),
    manifestId("b"),
  ]);
  assert.equal(plan.collections[0].itemCount, 2);
});

test("removes one of two members, leaving the collection alive", () => {
  const existing = leaf("campus-maps", "Campus Maps", [member("a", "Aardvark"), member("b", "Bison")]);
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("b", "Bison"),
    desired: [],
    root: rootWith([{slug: "campus-maps", label: "Campus Maps", thumbnail: null, itemCount: 2}]),
    leaves: {"campus-maps": existing},
  });

  assert.deepEqual(plan.leafDeletes, []);
  assert.deepEqual(plan.leafWrites[0].document.items.map((item) => item.id), [manifestId("a")]);
  assert.equal(plan.collections[0].itemCount, 1);
});

// Collections are explicit objects now: only an admin creates one, and only an
// admin deletes it. Emptying leaves it standing with items: [].
test("removing the last member empties the leaf but does not remove it", () => {
  const existing = leaf("campus-maps", "Campus Maps", [member("a", "Aardvark")]);
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("a", "Aardvark"),
    desired: [],
    root: rootWith([{slug: "campus-maps", label: "Campus Maps", thumbnail: null, itemCount: 1}]),
    leaves: {"campus-maps": existing},
  });

  assert.deepEqual(plan.leafDeletes, [], "reconciliation never deletes a collection");
  assert.deepEqual(slugsOf(plan.leafWrites), ["campus-maps"]);
  assert.deepEqual(plan.leafWrites[0].document.items, [], "an empty IIIF Collection, not a missing one");
  assert.equal(plan.leafWrites[0].document.type, "Collection");
  assert.deepEqual(plan.leafWrites[0].document.label, {none: ["Campus Maps"]}, "keeps its name");
  assert.deepEqual(
    plan.collections.map((c) => [c.slug, c.itemCount]),
    [["campus-maps", 0]],
    "still listed in the root, at zero",
  );
  assert.equal(plan.rootNext.items.length, 1);
  assert.equal(plan.rootChanged, true, "its item count changed");
});

test("handles an add and a remove in the same call", () => {
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("a", "Aardvark"),
    desired: [{slug: "annual-reports", label: "Annual Reports"}],
    root: rootWith([{slug: "campus-maps", label: "Campus Maps", thumbnail: null, itemCount: 1}]),
    leaves: {
      "campus-maps": leaf("campus-maps", "Campus Maps", [member("a", "Aardvark")]),
      "annual-reports": null,
    },
  });

  // Both are written: one gains the work, the other is left standing but empty.
  assert.deepEqual(slugsOf(plan.leafWrites), ["annual-reports", "campus-maps"]);
  assert.deepEqual(plan.leafDeletes, []);
  assert.deepEqual(
    plan.collections.map((c) => [c.slug, c.itemCount]),
    [["annual-reports", 1], ["campus-maps", 0]],
  );
});

test("a no-op save writes nothing at all", () => {
  const existing = leaf("campus-maps", "Campus Maps", [member("a", "Aardvark", THUMB)]);
  const root = rootWith([{slug: "campus-maps", label: "Campus Maps", thumbnail: THUMB, itemCount: 1}]);

  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("a", "Aardvark", THUMB),
    desired: [{slug: "campus-maps", label: "Campus Maps"}],
    root,
    leaves: {"campus-maps": existing},
  });

  assert.deepEqual(plan.leafWrites, [], "read-compare-write elides the leaf");
  assert.deepEqual(plan.leafDeletes, []);
  assert.equal(plan.rootChanged, false, "read-compare-write elides the root");
});

test("a retitled work refreshes its cached label in every collection", () => {
  const existing = leaf("campus-maps", "Campus Maps", [member("a", "Old Title")]);
  const root = rootWith([{slug: "campus-maps", label: "Campus Maps", thumbnail: null, itemCount: 1}]);

  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("a", "New Title"),
    // Membership unchanged — this is the desired === null path.
    desired: [{slug: "campus-maps", label: "Campus Maps"}],
    root,
    leaves: {"campus-maps": existing},
  });

  assert.deepEqual(slugsOf(plan.leafWrites), ["campus-maps"]);
  assert.deepEqual(plan.leafWrites[0].document.items[0].label, {none: ["New Title"]});
  assert.equal(plan.rootChanged, false, "the collection itself did not change");
});

test("deleting a work removes it from every collection it belonged to", () => {
  const plan = planReconciliation({
    baseUrl: BASE,
    // The manifest is gone, but its id is still how we find it in each leaf.
    member: member("a", "Aardvark"),
    removed: true,
    desired: [],
    root: rootWith([
      {slug: "campus-maps", label: "Campus Maps", thumbnail: null, itemCount: 2},
      {slug: "annual-reports", label: "Annual Reports", thumbnail: null, itemCount: 1},
      {slug: "untouched", label: "Untouched", thumbnail: null, itemCount: 4},
    ]),
    leaves: {
      "campus-maps": leaf("campus-maps", "Campus Maps", [member("a", "Aardvark"), member("b", "Bison")]),
      "annual-reports": leaf("annual-reports", "Annual Reports", [member("a", "Aardvark")]),
    },
  });

  assert.deepEqual(slugsOf(plan.leafWrites), ["annual-reports", "campus-maps"]);
  assert.deepEqual(plan.leafDeletes, []);
  assert.deepEqual(
    plan.collections.map((c) => c.slug).sort(),
    ["annual-reports", "campus-maps", "untouched"],
    "the emptied collection survives the work that was its only member",
  );
  assert.equal(plan.collections.find((c) => c.slug === "annual-reports").itemCount, 0);
  // A collection this work was never in passes through with its count intact.
  assert.equal(plan.collections.find((c) => c.slug === "untouched").itemCount, 4);
});

test("the root's existing label wins over a caller-supplied one", () => {
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("b", "Bison"),
    // A second curator types it in lower case; it must not retitle the collection.
    desired: [{slug: "campus-maps", label: "campus maps"}],
    root: rootWith([{slug: "campus-maps", label: "Campus Maps", thumbnail: null, itemCount: 1}]),
    leaves: {"campus-maps": leaf("campus-maps", "Campus Maps", [member("a", "Aardvark")])},
  });

  assert.deepEqual(plan.leafWrites[0].document.label, {none: ["Campus Maps"]});
  assert.equal(plan.collections[0].label, "Campus Maps");
});

test("output does not depend on input order", () => {
  const build = (desired, leaves) =>
    serializeCollection(
      planReconciliation({
        baseUrl: BASE,
        member: member("m", "Middle"),
        desired,
        root: createRootCollectionTemplate({baseUrl: BASE}),
        leaves,
      }),
    );

  const forwards = build(
    [
      {slug: "campus-maps", label: "Campus Maps"},
      {slug: "annual-reports", label: "Annual Reports"},
    ],
    {"campus-maps": null, "annual-reports": null},
  );
  const backwards = build(
    [
      {slug: "annual-reports", label: "Annual Reports"},
      {slug: "campus-maps", label: "Campus Maps"},
    ],
    {"annual-reports": null, "campus-maps": null},
  );
  assert.equal(forwards, backwards);
});

test("members sort deterministically by label then id", () => {
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("a", "Bison"),
    desired: [{slug: "campus-maps", label: "Campus Maps"}],
    root: createRootCollectionTemplate({baseUrl: BASE}),
    leaves: {
      "campus-maps": leaf("campus-maps", "Campus Maps", [
        member("z", "Aardvark"),
        member("y", "Coyote"),
      ]),
    },
  });
  assert.deepEqual(
    plan.leafWrites[0].document.items.map((item) => item.label.none[0]),
    ["Aardvark", "Bison", "Coyote"],
  );
});

test("the reserved root slug is never written or deleted as a leaf", () => {
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("a", "Aardvark"),
    desired: [{slug: "campus-maps", label: "Campus Maps"}],
    root: createRootCollectionTemplate({baseUrl: BASE}),
    leaves: {"campus-maps": null},
  });
  for (const slug of [...slugsOf(plan.leafWrites), ...slugsOf(plan.leafDeletes)]) {
    assert.notEqual(slug, ROOT_COLLECTION_SLUG);
  }
});

test("manifestThumbnail prefers the manifest's own, then the first canvas", () => {
  assert.deepEqual(manifestThumbnail({thumbnail: THUMB}), THUMB);
  assert.deepEqual(manifestThumbnail({items: [{thumbnail: THUMB}]}), THUMB);
  assert.equal(manifestThumbnail({items: []}), null);
  assert.equal(manifestThumbnail(null), null);
});

test("canonicalizeCollectionLabels adopts the existing collection's spelling", () => {
  const root = rootWith([{slug: "campus-maps", label: "Campus Maps", thumbnail: null, itemCount: 1}]);

  // A second curator's sloppy typing joins the collection without renaming it,
  // and without caching their spelling in their own manifest's partOf.
  assert.deepEqual(
    canonicalizeCollectionLabels([{slug: "campus-maps", label: "  campus   maps  "}], root),
    [{slug: "campus-maps", label: "Campus Maps"}],
  );

  // A genuinely new collection keeps the name it was given.
  assert.deepEqual(
    canonicalizeCollectionLabels([{slug: "annual-reports", label: "Annual Reports"}], root),
    [{slug: "annual-reports", label: "Annual Reports"}],
  );

  assert.deepEqual(canonicalizeCollectionLabels([], root), []);
  assert.deepEqual(canonicalizeCollectionLabels(null, root), []);
});

// --- member terms ------------------------------------------------------------

const {
  CONTENT_HASH_KEY,
  ITEM_COUNT_KEY,
  THUMBNAIL_SERVICE_KEY,
  memberFromManifest,
  canvasThumbnailService,
  workIdFromManifestUrl,
} = require("../collection");

const SERVICE = "https://images.example/iiif/3/w1%2F0";

const imageCanvas = (serviceId) => ({
  id: "c",
  type: "Canvas",
  items: [{items: [{body: {type: "Image", service: [{id: serviceId, type: "ImageService3"}]}}]}],
});

test("a member carries its hash, canvas count and list thumbnail", () => {
  const plan = planReconciliation({
    baseUrl: BASE,
    member: {...member("a", "Aardvark"), contentHash: "h-a", itemCount: 3, thumbnailService: SERVICE},
    desired: [{slug: "campus-maps", label: "Campus Maps"}],
    root: createRootCollectionTemplate({baseUrl: BASE}),
    leaves: {"campus-maps": null},
  });
  const [item] = plan.leafWrites[0].document.items;
  assert.equal(item[CONTENT_HASH_KEY], "h-a");
  assert.equal(item[ITEM_COUNT_KEY], 3);
  assert.equal(item[THUMBNAIL_SERVICE_KEY], SERVICE);
});

// Reconciliation rebuilds the whole leaf from its members, so a term it fails
// to carry is erased from every work the save was NOT about.
test("saving one work keeps every other member's terms intact", () => {
  const existing = leaf("campus-maps", "Campus Maps", [
    {...member("a", "Aardvark"), contentHash: "h-a", itemCount: 3, thumbnailService: SERVICE},
    {...member("b", "Bison"), contentHash: "h-b-old", itemCount: 1},
  ]);
  const plan = planReconciliation({
    baseUrl: BASE,
    member: {...member("b", "Bison"), contentHash: "h-b-new", itemCount: 2},
    desired: [{slug: "campus-maps", label: "Campus Maps"}],
    root: rootWith([{slug: "campus-maps", label: "Campus Maps", thumbnail: null, itemCount: 2}]),
    leaves: {"campus-maps": existing},
  });
  const [a, b] = plan.leafWrites[0].document.items;
  assert.equal(a[CONTENT_HASH_KEY], "h-a", "untouched member keeps its hash");
  assert.equal(a[ITEM_COUNT_KEY], 3);
  assert.equal(a[THUMBNAIL_SERVICE_KEY], SERVICE);
  assert.equal(b[CONTENT_HASH_KEY], "h-b-new", "the saved member takes the new hash");
  assert.equal(b[ITEM_COUNT_KEY], 2);
});

// A missing hash reads as "changed". Defaulting it to anything would risk the
// opposite error: a work shown as published that never gets republished.
test("an unknown hash is left out rather than guessed", () => {
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("a", "Aardvark"),
    desired: [{slug: "campus-maps", label: "Campus Maps"}],
    root: createRootCollectionTemplate({baseUrl: BASE}),
    leaves: {"campus-maps": null},
  });
  const [item] = plan.leafWrites[0].document.items;
  assert.equal(CONTENT_HASH_KEY in item, false);
  assert.equal(THUMBNAIL_SERVICE_KEY in item, false);
});

test("memberFromManifest derives everything but the hash from the manifest", () => {
  const manifest = {
    id: manifestId("w1"),
    label: {en: ["Map of campus"]},
    items: [{id: "silent", type: "Canvas", items: []}, imageCanvas(SERVICE), imageCanvas("https://other")],
  };
  assert.deepEqual(memberFromManifest(manifest, {contentHash: "h"}), {
    manifestId: manifestId("w1"),
    label: "Map of campus",
    thumbnail: null,
    contentHash: "h",
    itemCount: 3,
    // The first canvas that HAS a service, which is what the list showed before.
    thumbnailService: SERVICE,
  });
});

test("canvasThumbnailService falls back to an A/V canvas's poster", () => {
  assert.equal(canvasThumbnailService(imageCanvas(SERVICE)), SERVICE);
  const video = {items: [{items: [{body: {type: "Video"}}]}], thumbnail: [{service: [{id: "poster-svc"}]}]};
  assert.equal(canvasThumbnailService(video), "poster-svc");
  assert.equal(canvasThumbnailService({items: []}), null);
});

test("workIdFromManifestUrl reads either space, and nothing else", () => {
  assert.equal(workIdFromManifestUrl(`${BASE}/working/presentation/manifest/w1/manifest.json`), "w1");
  assert.equal(workIdFromManifestUrl(`${BASE}/published/presentation/manifest/w1/manifest.json`), "w1");
  assert.equal(workIdFromManifestUrl(`${BASE}/working/presentation/collection/x/collection.json`), null);
  assert.equal(workIdFromManifestUrl(undefined), null);
});
