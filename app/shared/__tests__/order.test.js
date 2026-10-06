const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCollectionDocument,
  buildManifestReference,
  createRootCollectionTemplate,
  planReconciliation,
  isLabelSorted,
  arrangeMembers,
  moveMember,
  membersOf,
} = require("../collection");

const BASE = "https://example-iiif.s3.us-east-1.amazonaws.com";
const manifestId = (id) => `${BASE}/working/presentation/manifest/${id}/manifest.json`;
const member = (id, label) => ({manifestId: manifestId(id), label, thumbnail: null});
const ref = (id, label) => buildManifestReference(member(id, label));
const ids = (items) => items.map((item) => item.id.split("/manifest/")[1].split("/")[0]);

const leafOf = (members) => buildCollectionDocument({baseUrl: BASE, slug: "c", label: "C", members});

test("a list in label order is recognised as such", () => {
  assert.equal(isLabelSorted([]), true);
  assert.equal(isLabelSorted([ref("b", "Beta")]), true);
  assert.equal(isLabelSorted([ref("a", "Alpha"), ref("b", "Beta")]), true);
  assert.equal(isLabelSorted([ref("b", "Beta"), ref("a", "Alpha")]), false);
});

test("a new work goes where its label sorts, in a collection nobody has ordered", () => {
  const existing = [ref("a", "Alpha"), ref("c", "Gamma")];
  assert.deepEqual(ids(arrangeMembers(existing, [ref("b", "Beta")])), ["a", "b", "c"]);
});

test("a renamed work moves to where its label sorts, in a collection nobody has ordered", () => {
  const existing = [ref("a", "Alpha"), ref("b", "Beta"), ref("c", "Gamma")];
  assert.deepEqual(ids(arrangeMembers(existing, [ref("a", "Zeta")])), ["b", "c", "a"]);
});

test("a hand-ordered collection keeps its order, and a new work goes on the end", () => {
  const existing = [ref("c", "Gamma"), ref("a", "Alpha"), ref("b", "Beta")];
  assert.deepEqual(ids(arrangeMembers(existing, [ref("d", "Aardvark")])), ["c", "a", "b", "d"]);
});

test("an edited work keeps its place in a hand-ordered collection, and takes its new terms", () => {
  const existing = [ref("c", "Gamma"), ref("a", "Alpha")];
  const arranged = arrangeMembers(existing, [ref("a", "Alpha, revised")]);
  assert.deepEqual(ids(arranged), ["c", "a"]);
  assert.equal(arranged[1].label.none[0], "Alpha, revised");
});

test("moving a work puts it after the one named", () => {
  const list = [ref("a", "A"), ref("b", "B"), ref("c", "C"), ref("d", "D")];
  assert.deepEqual(ids(moveMember(list, list[0].id, list[2].id)), ["b", "c", "a", "d"]);
  assert.deepEqual(ids(moveMember(list, list[3].id, list[0].id)), ["a", "d", "b", "c"]);
});

test("moving after null moves a work to the front", () => {
  const list = [ref("a", "A"), ref("b", "B"), ref("c", "C")];
  assert.deepEqual(ids(moveMember(list, list[2].id, null)), ["c", "a", "b"]);
});

test("a move that changes nothing, or names nobody, is refused", () => {
  const list = [ref("a", "A"), ref("b", "B"), ref("c", "C")];
  assert.equal(moveMember(list, list[1].id, list[0].id), null, "already after a");
  assert.equal(moveMember(list, list[0].id, null), null, "already first");
  assert.equal(moveMember(list, list[0].id, list[0].id), null, "after itself");
  assert.equal(moveMember(list, manifestId("zz"), list[0].id), null, "unknown work");
  assert.equal(moveMember(list, list[0].id, manifestId("zz")), null, "unknown anchor");
});

test("a move never changes which works there are", () => {
  const list = [ref("a", "A"), ref("b", "B"), ref("c", "C"), ref("d", "D")];
  const moved = moveMember(list, list[1].id, list[3].id);
  assert.deepEqual([...ids(moved)].sort(), ["a", "b", "c", "d"]);
});

test("saving a work leaves a hand-ordered collection in its order", () => {
  const existing = leafOf([member("c", "Gamma"), member("a", "Alpha"), member("b", "Beta")]);
  const plan = planReconciliation({
    baseUrl: BASE,
    member: {...member("a", "Alpha"), contentHash: "h2"},
    desired: [{slug: "c", label: "C"}],
    root: createRootCollectionTemplate({baseUrl: BASE}),
    leaves: {c: existing},
  });
  const written = plan.leafWrites.find((write) => write.slug === "c");
  assert.deepEqual(ids(membersOf(written.document)), ["c", "a", "b"]);
});

test("adding a work to a hand-ordered collection puts it on the end", () => {
  const existing = leafOf([member("c", "Gamma"), member("a", "Alpha")]);
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("b", "Aardvark"),
    desired: [{slug: "c", label: "C"}],
    root: createRootCollectionTemplate({baseUrl: BASE}),
    leaves: {c: existing},
  });
  const written = plan.leafWrites.find((write) => write.slug === "c");
  assert.deepEqual(ids(membersOf(written.document)), ["c", "a", "b"]);
});

test("removing a work leaves the rest of a hand-ordered collection in order", () => {
  const existing = leafOf([member("c", "Gamma"), member("a", "Alpha"), member("b", "Beta")]);
  const plan = planReconciliation({
    baseUrl: BASE,
    member: member("a", "Alpha"),
    removed: true,
    desired: [],
    root: createRootCollectionTemplate({baseUrl: BASE}),
    leaves: {c: existing},
  });
  const written = plan.leafWrites.find((write) => write.slug === "c");
  assert.deepEqual(ids(membersOf(written.document)), ["c", "b"]);
});
