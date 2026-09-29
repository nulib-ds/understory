const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CONTENT_HASH_KEY,
  contentHash,
  isSelfReference,
  publishDocument,
  externalImageServices,
  planPublish,
  aliasFlipActions,
} = require("../publish");

const BASE = "https://stack-iiif.s3.us-east-1.amazonaws.com";
const FROM = `${BASE}/working`;
const TO = `${BASE}/published`;
// A CloudFront host, entirely distinct from the bucket origin — which is what
// makes image services safe from the rewrite by construction.
const IMAGE_API = "https://d123.cloudfront.net/iiif/2";

const fixture = () =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "__fixtures__", "nul-manifest.json"), "utf8"),
  );

test("a self-reference is matched at a path boundary, not by prefix", () => {
  assert.equal(isSelfReference(`${FROM}/presentation/manifest/a/manifest.json`, FROM), true);
  assert.equal(isSelfReference(FROM, FROM), true);
  // The bug a bare startsWith would introduce.
  assert.equal(isSelfReference(`${BASE}/working-notes/secret.json`, FROM), false);
  assert.equal(isSelfReference(`${BASE}/published/x`, FROM), false);
  assert.equal(isSelfReference(42, FROM), false);
});

test("every self-referential URL moves, including a bare Annotation.target", () => {
  const working = {
    id: `${FROM}/presentation/manifest/a/manifest.json`,
    partOf: [{id: `${FROM}/presentation/collection/eis/collection.json`, type: "Collection"}],
    thumbnail: [{id: `${IMAGE_API}/img/full/200,/0/default.jpg`, type: "Image"}],
    items: [
      {
        id: `${FROM}/presentation/manifest/a/canvas/1`,
        items: [
          {
            id: `${FROM}/presentation/manifest/a/canvas/1/page/1`,
            items: [
              {
                id: `${FROM}/presentation/manifest/a/canvas/1/annotation/1`,
                // Not an object with an id — a plain string. An id-key walker
                // would leave this pointing at a canvas that does not exist in
                // the published space, and nothing would error.
                target: `${FROM}/presentation/manifest/a/canvas/1`,
                body: {id: `${IMAGE_API}/img/full/max/0/default.jpg`, service: [{id: `${IMAGE_API}/img`}]},
              },
            ],
          },
        ],
      },
    ],
  };
  const {document, replacements} = publishDocument(working, {from: FROM, to: TO});
  assert.equal(replacements, 6);
  assert.equal(document.id, `${TO}/presentation/manifest/a/manifest.json`);
  assert.equal(document.partOf[0].id, `${TO}/presentation/collection/eis/collection.json`);
  assert.equal(document.items[0].items[0].items[0].target, `${TO}/presentation/manifest/a/canvas/1`);
  // Images are not duplicated by publishing; the Image API is one endpoint.
  assert.equal(document.thumbnail[0].id, `${IMAGE_API}/img/full/200,/0/default.jpg`);
  assert.equal(document.items[0].items[0].items[0].body.service[0].id, `${IMAGE_API}/img`);
  // The input is not mutated.
  assert.equal(working.id, `${FROM}/presentation/manifest/a/manifest.json`);
});

test("@context is never rewritten", () => {
  const working = {
    "@context": [`${FROM}/ns#`, "http://iiif.io/api/presentation/3/context.json"],
    id: `${FROM}/presentation/manifest/a/manifest.json`,
  };
  const {document} = publishDocument(working, {from: FROM, to: TO});
  assert.deepEqual(document["@context"], working["@context"]);
});

test("publishing is idempotent in the space it produces", () => {
  const working = {id: `${FROM}/presentation/manifest/a/manifest.json`};
  const once = publishDocument(working, {from: FROM, to: TO});
  const twice = publishDocument(once.document, {from: FROM, to: TO});
  assert.deepEqual(twice.document, once.document);
  assert.equal(twice.replacements, 0, "nothing left to move, which is how a bad input is spotted");
});

// An imported manifest keeps the source institution's ids as provenance. They
// are on another host, so the rewrite must leave every one of them alone.
test("a third-party manifest's own URLs survive untouched", () => {
  const imported = fixture();
  imported.id = `${FROM}/presentation/manifest/abc/manifest.json`;
  const before = JSON.stringify(imported.partOf);
  const {document, replacements} = publishDocument(imported, {from: FROM, to: TO});
  assert.equal(replacements, 1, "only the id we own");
  assert.equal(JSON.stringify(document.partOf), before, "provenance is verbatim");
  assert.match(JSON.stringify(document.items), /api\.dc\.library\.northwestern\.edu/);
});

test("external image services are counted so a run can warn about them", () => {
  const imported = fixture();
  const external = externalImageServices(imported, IMAGE_API);
  assert.ok(external.length > 0, "this work was never imported, so it hotlinks");
  assert.ok(external.every((id) => !id.startsWith(IMAGE_API)));
  // Once imported, every service points at our own endpoint.
  assert.deepEqual(
    externalImageServices({items: [{service: [{id: `${IMAGE_API}/x`}]}]}, IMAGE_API),
    [],
  );
});

test("contentHash is of the bytes, so it is reproducible", () => {
  const bytes = JSON.stringify({b: 1, a: 2}, null, 2);
  assert.equal(contentHash(bytes), contentHash(bytes));
  assert.notEqual(contentHash(bytes), contentHash(JSON.stringify({a: 2, b: 1}, null, 2)));
  assert.match(contentHash("x"), /^[0-9a-f]{64}$/);
});

test("planPublish compares artifacts, not a journal", () => {
  const working = [
    {workId: "same", contentHash: "h1"},
    {workId: "edited", contentHash: "h2-new"},
    {workId: "brand-new", contentHash: "h3"},
  ];
  const published = [
    {workId: "same", [CONTENT_HASH_KEY]: "h1"},
    {workId: "edited", [CONTENT_HASH_KEY]: "h2-old"},
    {workId: "departed", [CONTENT_HASH_KEY]: "h4"},
  ];
  const plan = planPublish({workingMembers: working, publishedMembers: published});
  assert.deepEqual(plan.adds.map((m) => m.workId), ["brand-new"]);
  assert.deepEqual(plan.changes.map((m) => m.workId), ["edited"]);
  assert.deepEqual(plan.unchanged.map((m) => m.workId), ["same"]);
  assert.deepEqual(plan.removes.map((m) => m.workId), ["departed"]);
  assert.equal(plan.total, 3);
});

test("a collection that has never been published is all adds", () => {
  const plan = planPublish({workingMembers: [{workId: "a", contentHash: "h"}], publishedMembers: []});
  assert.equal(plan.adds.length, 1);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.removes.length, 0);
});

// A work saved while the run is copying is published at the hash it had when
// the run read it, so the NEXT diff correctly shows it as changed again.
// That self-correction is why the run needs no lock.
test("a work edited mid-run shows as changed again afterwards", () => {
  const publishedAfterRun = [{workId: "w", [CONTENT_HASH_KEY]: "hash-at-read-time"}];
  const plan = planPublish({
    workingMembers: [{workId: "w", contentHash: "hash-after-the-edit"}],
    publishedMembers: publishedAfterRun,
  });
  assert.deepEqual(plan.changes.map((m) => m.workId), ["w"]);
});

test("the alias flip is one atomic batch, and deletes nothing", () => {
  const actions = aliasFlipActions({
    index: "s.eis._pub.r2",
    liveAlias: "s.eis",
    stagedAlias: "s.eis._staged",
    previousIndex: "s.eis._pub.r1",
  });
  assert.deepEqual(actions, [
    {remove: {index: "s.eis._pub.r1", alias: "s.eis"}},
    {add: {index: "s.eis._pub.r2", alias: "s.eis"}},
    {remove: {index: "s.eis._pub.r2", alias: "s.eis._staged"}},
  ]);
  // GC happens at the start of the next run, never here: a flip must be safe
  // to retry, and must not be able to drop an index a concurrent run is
  // writing into.
  assert.equal(actions.some((a) => a.remove_index), false);
});

test("the first flip for a collection has no previous alias to remove", () => {
  const actions = aliasFlipActions({
    index: "s.eis._pub.r1",
    liveAlias: "s.eis",
    stagedAlias: "s.eis._staged",
    previousIndex: null,
  });
  assert.deepEqual(actions[0], {add: {index: "s.eis._pub.r1", alias: "s.eis"}});
  assert.equal(actions.length, 2);
});

// --- published documents must describe the published space -----------------
//
// Regression: the published collection and root were built by
// buildCollectionDocument / buildRootCollectionDocument, whose `space`
// defaulted to WORKING. Their `items` were right (built from already-published
// manifest URLs) while their own `id` and `partOf` pointed back into
// `working/`, so a consumer walking the published root left the space on its
// first link. Nothing caught it because publishDocument was never involved.

const {
  WORKING,
  PUBLISHED,
} = require("../space");
const {
  MANAGED_KEY,
  buildCollectionDocument,
  buildRootCollectionDocument,
  createRootCollectionTemplate,
} = require("../collection");

const member = {
  manifestId: `${TO}/presentation/manifest/w1/manifest.json`,
  label: "A work",
  thumbnail: null,
};

test("a published leaf collection describes itself in the published space", () => {
  const doc = buildCollectionDocument({
    baseUrl: BASE, space: PUBLISHED, slug: "fava", label: "Fava masks", members: [member],
  });
  assert.equal(doc.id, `${TO}/presentation/collection/fava/collection.json`);
  assert.equal(doc.partOf[0].id, `${TO}/presentation/collection/index/collection.json`);
  assert.equal(doc.items[0].id, member.manifestId);
  for (const url of [doc.id, doc.partOf[0].id, doc.items[0].id]) {
    assert.ok(!url.includes("/working/"), `leaked into working: ${url}`);
  }
});

test("a published root collection describes itself in the published space", () => {
  const doc = buildRootCollectionDocument({
    baseUrl: BASE, space: PUBLISHED,
    collections: [{slug: "fava", label: "Fava masks", itemCount: 1, thumbnail: null}],
  });
  assert.equal(doc.id, `${TO}/presentation/collection/index/collection.json`);
  assert.equal(doc.items[0].id, `${TO}/presentation/collection/fava/collection.json`);
  assert.ok(!JSON.stringify(doc).includes("/working/"), "no working URL anywhere in the root");
});

test("an empty published root template stays in the published space", () => {
  const doc = createRootCollectionTemplate({baseUrl: BASE, space: PUBLISHED});
  assert.equal(doc.id, `${TO}/presentation/collection/index/collection.json`);
  assert.deepEqual(doc.items, []);
});

test("the working space is still the default, and is unchanged", () => {
  const doc = buildCollectionDocument({baseUrl: BASE, slug: "fava", label: "F", members: []});
  assert.equal(doc.id, `${FROM}/presentation/collection/fava/collection.json`);
  assert.equal(
    doc.id,
    buildCollectionDocument({baseUrl: BASE, space: WORKING, slug: "fava", label: "F", members: []}).id,
  );
});

// --- bookkeeping terms do not belong in the published artifact -------------

test("publishDocument strips the keys it is told to, at any depth", () => {
  const working = {
    id: `${FROM}/presentation/manifest/w1/manifest.json`,
    partOf: [
      {id: "https://example.org/their/collection.json", type: "Collection"},
      {id: `${FROM}/presentation/collection/fava/collection.json`, type: "Collection", [MANAGED_KEY]: true},
    ],
  };
  const {document} = publishDocument(working, {from: FROM, to: TO, strip: [MANAGED_KEY]});

  assert.equal(document.id, `${TO}/presentation/manifest/w1/manifest.json`);
  assert.equal(document.partOf[1].id, `${TO}/presentation/collection/fava/collection.json`);
  assert.ok(!(MANAGED_KEY in document.partOf[1]), "our marker is gone");
  // Third-party provenance is untouched — different host, and no marker to lose.
  assert.equal(document.partOf[0].id, "https://example.org/their/collection.json");
  assert.ok(!JSON.stringify(document).includes(MANAGED_KEY));
});

// CONTENT_HASH_KEY must survive: planPublish compares against exactly that, so
// stripping every extension term would silently disable change detection.
test("stripping is opt-in per key, so the content hash survives", () => {
  const doc = {id: `${FROM}/a`, items: [{id: `${FROM}/b`, [CONTENT_HASH_KEY]: "abc", [MANAGED_KEY]: true}]};
  const {document} = publishDocument(doc, {from: FROM, to: TO, strip: [MANAGED_KEY]});
  assert.equal(document.items[0][CONTENT_HASH_KEY], "abc");
  assert.ok(!(MANAGED_KEY in document.items[0]));
});

test("publishDocument with no strip list behaves exactly as before", () => {
  const doc = {id: `${FROM}/a`, [MANAGED_KEY]: true};
  const {document, replacements} = publishDocument(doc, {from: FROM, to: TO});
  assert.equal(document[MANAGED_KEY], true);
  assert.equal(replacements, 1);
});
