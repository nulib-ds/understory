// IIIF Presentation 3.0 Collections.
//
// Membership is authoritative in each manifest's `partOf`; the collection
// documents under `presentation/collection/` are a derived projection that can
// be rebuilt from the manifests alone. Everything in this module is pure — the
// IO lives in `app/aws/lambdas/manifest/collections.js`.
//
// Deliberately depends on nothing but ./language: manifest.js loads the AWS SDK
// at module scope, and pulling that in would make these pure functions
// untestable without it.
const {languageMap, extractLabel} = require("./language");
const {WORKING, spaceKey} = require("./space");

const COLLECTION_PREFIX = "presentation/collection";
const COLLECTION_OBJECT = "collection.json";

// The collection of collections. Always exists, even with no members, and is
// the only slug a user may not claim.
const ROOT_COLLECTION_SLUG = "index";
const ROOT_COLLECTION_LABEL = "All Collections";

const PRESENTATION_CONTEXT = "http://iiif.io/api/presentation/3/context.json";

// A registered-extension-style namespace, per the IIIF extension guidance. The
// trailing "#" is load-bearing: under JSON-LD 1.1 a simple term definition is
// only usable as a compact-IRI prefix when its value ends in a gen-delim, so
// dropping it would make `staticiiif:managed` silently fail to expand.
const STATIC_IIIF_PREFIX = "staticiiif";
const STATIC_IIIF_NAMESPACE = "https://nulib-labs.github.io/static-iiif/ns#";
// Absolute IRIs, not `staticiiif:`-prefixed compact IRIs. A compact IRI needs a
// prefix declared in @context, and declaring one means putting an object into
// the @context array — which is legal JSON-LD 1.1 and which Clover cannot read
// (see normalizeContext). An absolute IRI expands on its own.
const MANAGED_KEY = `${STATIC_IIIF_NAMESPACE}managed`;
const ITEM_COUNT_KEY = `${STATIC_IIIF_NAMESPACE}itemCount`;

const MAX_LABEL_LENGTH = 200;
const MAX_SLUG_LENGTH = 96;
// A work belongs to exactly one collection. This is the single place the rule
// is enforced; the plumbing below still works in lists, because a move touches
// two collections and reconciliation has to see both.
const MAX_COLLECTIONS_PER_WORK = 1;

const collectionSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const collectionIdPattern = /\/presentation\/collection\/([a-z0-9-]+)\/collection\.json$/;

// Slugs a collection may not take, because a route already means something else
// by them. "index" is the root register's own slug. "import" is the collection
// import's route segment — POST /collections/import would otherwise be
// ambiguous with a collection legitimately named "import", and the pattern
// above happily allows that name.
//
// Mirrored in ui/src/lib/collectionSlug.js; the two have to move together.
const RESERVED_COLLECTION_SLUGS = new Set([ROOT_COLLECTION_SLUG, "import"]);

class CollectionNameError extends Error {}

// The label is a display string and nothing else. It is NOT reduced to a slug
// here, and never should be again.
//
// The slug used to be derived from this, which quietly turned a mutable display
// string into a permanent identifier — and meant a collection could not be named
// in any non-Latin script at all: "日本語資料" reduced to the empty string and
// threw. A curator now names the collection in whatever language the material is
// in, and chooses an ASCII slug alongside it.
function sanitizeCollectionLabel(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new CollectionNameError("A collection name is required");
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new CollectionNameError(
      `Collection names are limited to ${MAX_LABEL_LENGTH} characters`,
    );
  }
  return trimmed;
}

// Validates a value that is already a slug without transforming it — both for a
// slug arriving from a client, and for one read back out of a stored id, where a
// silent rewrite would mask corruption rather than surface it.
//
// A chosen slug is permanent and public, so this is the only gate it passes
// through. The pattern forbids a leading "-" or "_", which is what keeps a
// user-chosen slug structurally unable to collide with the reserved
// "_"-prefixed index segments in search.js — that collision used to be defended
// by naming convention alone (see AGENTS.md on {prefix}.working).
function sanitizeCollectionSlug(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new CollectionNameError("A collection id is required");
  }
  if (!collectionSlugPattern.test(trimmed)) {
    throw new CollectionNameError(
      "Collection ids may only include lowercase letters, numbers, and single dashes",
    );
  }
  // Bounded here rather than by the pattern so the message can say why. It used
  // to be enforced by the truncation inside the old slugifier; nothing enforced
  // it on a slug that arrived already-formed.
  if (trimmed.length > MAX_SLUG_LENGTH) {
    throw new CollectionNameError(
      `Collection ids are limited to ${MAX_SLUG_LENGTH} characters`,
    );
  }
  if (RESERVED_COLLECTION_SLUGS.has(trimmed)) {
    throw new CollectionNameError(`"${trimmed}" is a reserved collection name`);
  }
  return trimmed;
}

// Deliberately does not run the reserved-slug check, so rootCollectionKey can
// call through it.
function collectionObjectKey(slug, space = WORKING) {
  return spaceKey(space, `${COLLECTION_PREFIX}/${slug}/${COLLECTION_OBJECT}`);
}

function rootCollectionKey(space = WORKING) {
  return collectionObjectKey(ROOT_COLLECTION_SLUG, space);
}

function buildCollectionId(baseUrl, slug, space = WORKING) {
  const normalizedBase = (baseUrl || "").replace(/\/$/, "");
  const key = collectionObjectKey(slug, space);
  return normalizedBase ? `${normalizedBase}/${key}` : key;
}

function buildRootCollectionId(baseUrl, space = WORKING) {
  return buildCollectionId(baseUrl, ROOT_COLLECTION_SLUG, space);
}

function collectionSlugFromId(id) {
  const match = collectionIdPattern.exec(typeof id === "string" ? id : "");
  return match ? match[1] : null;
}

// Presentation 3.0: the value must be the presentation context URI, or an array
// with it LAST. This only ever normalizes what a manifest arrived with — we add
// no extension context of our own.
//
// We used to declare a `staticiiif` prefix here as an inline term-definition
// object, so `staticiiif:managed` would expand. That is valid JSON-LD 1.1 and
// it broke Clover: it maps over @context calling `.replace("http://","https://")`
// on every entry, guarding only against null, so an object entry threw
// "r.replace is not a function" and the viewer never rendered. Clover is what
// Canopy uses, so a manifest we publish with an object in @context breaks
// downstream consumers too, not just this app.
//
// The extension terms are absolute IRIs now (see MANAGED_KEY). An absolute IRI
// needs no prefix declaration, so @context goes back to being the bare
// presentation string and there is nothing for a consumer to trip over.
function normalizeContext(existing) {
  const entries = Array.isArray(existing) ? existing : existing ? [existing] : [];
  const foreign = entries.filter((entry) => {
    if (entry === PRESENTATION_CONTEXT) return false;
    // Shed any prefix declaration — ours, from before this changed, or another
    // deployment's that came in with an import.
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const keys = Object.keys(entry);
      return !(keys.length === 1 && keys[0] === STATIC_IIIF_PREFIX);
    }
    return true;
  });
  const next = [...foreign, PRESENTATION_CONTEXT];
  return next.length === 1 ? PRESENTATION_CONTEXT : next;
}

function buildPartOfEntry({baseUrl, slug, label}) {
  return {
    id: buildCollectionId(baseUrl, slug),
    type: "Collection",
    label: languageMap(label),
    [MANAGED_KEY]: true,
  };
}

// Is this partOf entry one of ours?
//
// Two independent signals, because each fails alone: the marker is lost to a
// hand-edit, and the path check breaks the day IIIF_BASE_URL moves to a custom
// domain. The baseUrl clause is what stops us claiming a collection belonging to
// *another* static-iiif deployment whose manifest we imported — those arrive
// carrying a genuine marker pointing at a bucket we do not own.
function isManagedPartOfEntry(entry, {baseUrl} = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (entry[MANAGED_KEY] !== true && !collectionIdPattern.test(id)) return false;

  const normalizedBase = (baseUrl || "").replace(/\/$/, "");
  if (!normalizedBase) return true;
  return id.startsWith(`${normalizedBase}/`);
}

function partOfEntries(partOf) {
  return Array.isArray(partOf) ? partOf.filter(Boolean) : [];
}

// Our entries, in document order, as {slug, label, id}.
function managedCollectionRefs(partOf, {baseUrl} = {}) {
  return partOfEntries(partOf)
    .filter((entry) => isManagedPartOfEntry(entry, {baseUrl}))
    .map((entry) => ({
      slug: collectionSlugFromId(entry.id),
      label: extractLabel(entry.label),
      id: entry.id,
    }))
    .filter((ref) => Boolean(ref.slug));
}

// Everything that is not ours — an imported manifest's link back to the source
// institution's collection, which we preserve verbatim.
// The one collection a work belongs to, or null. managedCollectionRefs stays
// for reconciliation and for reading a manifest that predates the rule.
function managedCollectionRef(partOf, options = {}) {
  return managedCollectionRefs(partOf, options)[0] || null;
}

function foreignPartOfEntries(partOf, {baseUrl} = {}) {
  return partOfEntries(partOf).filter((entry) => !isManagedPartOfEntry(entry, {baseUrl}));
}

// On import, drop entries that carry our marker but point somewhere we do not
// own. Without this, importing from another static-iiif deployment injects
// membership in collections nobody here asked for.
function stripForeignManagedEntries(manifest, {baseUrl}) {
  const entries = partOfEntries(manifest?.partOf);
  const kept = entries.filter(
    (entry) => !isManagedPartOfEntry(entry, {}) || isManagedPartOfEntry(entry, {baseUrl}),
  );
  if (kept.length === entries.length) return manifest;

  const next = {...manifest};
  if (kept.length) {
    next.partOf = kept;
  } else {
    delete next.partOf;
  }
  next["@context"] = normalizeContext(manifest?.["@context"]);
  return next;
}

// Rewrite a manifest's managed membership, leaving foreign entries untouched at
// the front. Ours are sorted by slug so the document serializes deterministically
// — read-compare-write depends on that to elide no-op writes.
function applyCollections(manifest, {baseUrl, collections}) {
  const next = {...manifest};
  const foreign = foreignPartOfEntries(manifest?.partOf, {baseUrl});
  const ours = [...(collections || [])]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map(({slug, label}) => buildPartOfEntry({baseUrl, slug, label}));

  const partOf = [...foreign, ...ours];
  if (partOf.length) {
    next.partOf = partOf;
  } else {
    // The spec describes partOf as having "at least one item", so unset the key
    // rather than writing an empty array.
    delete next.partOf;
  }
  next["@context"] = normalizeContext(manifest?.["@context"]);
  return next;
}

function buildManifestReference({manifestId, label, thumbnail}) {
  const reference = {
    id: manifestId,
    type: "Manifest",
    label: languageMap(label),
  };
  if (thumbnail && thumbnail.length) {
    reference.thumbnail = thumbnail;
  }
  return reference;
}

// An entry in the root collection. Carries the item count twice on purpose:
// `metadata` is the only display-legal slot Presentation 3.0 offers, but reading
// "12" back out of a language map keyed on the English word "Items" is fragile,
// and clients that merge references with the dereferenced document by id would
// drop it entirely (the leaf carries no metadata). The prefixed term is what our
// own API reads.
function buildCollectionReference({baseUrl, slug, label, thumbnail, itemCount, space = WORKING}) {
  const reference = {
    id: buildCollectionId(baseUrl, slug, space),
    type: "Collection",
    label: languageMap(label),
  };
  if (thumbnail && thumbnail.length) {
    reference.thumbnail = thumbnail;
  }
  reference.metadata = [
    {label: languageMap("Items"), value: languageMap(String(itemCount))},
  ];
  reference[ITEM_COUNT_KEY] = itemCount;
  return reference;
}

// `space` is not optional in spirit: a document must describe its OWN space, or
// a consumer walking the published tree is thrown back into `working/` by the
// first link it follows. The WORKING default exists because the manifest API
// only ever builds working documents; every publish-side caller must pass
// PUBLISHED explicitly.
function buildCollectionDocument({baseUrl, slug, label, members, space = WORKING}) {
  const items = members.map(buildManifestReference);
  const thumbnail = members.find((member) => member.thumbnail?.length)?.thumbnail;

  const document = {
    // The leaf carries no prefixed term, so it needs no extension prefix.
    "@context": PRESENTATION_CONTEXT,
    id: buildCollectionId(baseUrl, slug, space),
    type: "Collection",
    label: languageMap(label),
  };
  if (thumbnail) {
    document.thumbnail = thumbnail;
  }
  document.partOf = [
    {
      id: buildRootCollectionId(baseUrl, space),
      type: "Collection",
      label: languageMap(ROOT_COLLECTION_LABEL),
    },
  ];
  document.items = items;
  return document;
}

// `items: []` is explicitly permitted by the spec ("allowed but discouraged"),
// which is what lets the root exist before any collection does.
function buildRootCollectionDocument({baseUrl, collections, space = WORKING}) {
  const items = collections.map((collection) =>
    buildCollectionReference({baseUrl, ...collection, space}),
  );
  return {
    "@context": PRESENTATION_CONTEXT,
    id: buildRootCollectionId(baseUrl, space),
    type: "Collection",
    label: languageMap(ROOT_COLLECTION_LABEL),
    items,
  };
}

function createRootCollectionTemplate({baseUrl, space = WORKING}) {
  return buildRootCollectionDocument({baseUrl, collections: [], space});
}

// Flatten a stored root document into the shape GET /collections returns.
function rootCollectionSummaries(root) {
  return partOfEntries(root?.items)
    .map((entry) => {
      const slug = collectionSlugFromId(entry.id);
      if (!slug) return null;
      return {
        slug,
        label: extractLabel(entry.label),
        id: entry.id,
        itemCount: readItemCount(entry),
        thumbnail: entry.thumbnail || null,
      };
    })
    .filter(Boolean);
}

function readItemCount(entry) {
  if (typeof entry?.[ITEM_COUNT_KEY] === "number") return entry[ITEM_COUNT_KEY];
  const metadata = Array.isArray(entry?.metadata) ? entry.metadata : [];
  for (const field of metadata) {
    if (extractLabel(field?.label) === "Items") {
      const parsed = Number.parseInt(extractLabel(field?.value), 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

// Canonical serialization. Reconciliation compares against it to skip writes
// that would change nothing, which is also what makes a retry after a partial
// failure repair the projection instead of short-circuiting.
const serializeCollection = (document) => JSON.stringify(document, null, 2);

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

function sortMembers(members) {
  return [...members].sort(
    (a, b) => extractLabel(a.label).localeCompare(extractLabel(b.label)) || String(a.id).localeCompare(String(b.id)),
  );
}

function membersOf(document) {
  return Array.isArray(document?.items) ? document.items.filter((item) => item && item.id) : [];
}

// Resolve each slug to the label the collection actually carries.
//
// This used to correct a curator's spelling — the wire shape was a label, so
// typing "campus maps" had to be reconciled with the existing "Campus Maps".
// The wire shape is a slug now, so there is no spelling to forgive; what is
// left is the lookup, which is still needed because applyCollections caches the
// label inside each manifest's partOf and that cache has to match the
// collection's real name.
function canonicalizeCollectionLabels(desired, root) {
  const canonical = new Map(rootCollectionSummaries(root).map((entry) => [entry.slug, entry.label]));
  return (desired || []).map((entry) => ({
    ...entry,
    label: canonical.get(entry.slug) || entry.label,
  }));
}

// Rebuild every touched collection document, plus the root, from documents we
// already hold. A leaf document IS its own member list, so no corpus scan is
// needed on this path.
//
// Collections are explicit objects: an admin creates them on the Collections
// screen and deletes them there. Emptying one does NOT remove it — it is
// rewritten with `items: []`, which the Presentation spec permits ("allowed but
// discouraged", the same allowance the root relies on).
//
// That is a deliberate reversal of the original "a collection with no items
// ceases to exist" rule, and it moves the authoritative list of WHICH
// collections exist out of the manifests and into the root document. Reindex
// therefore has to merge with the root rather than rebuild purely from the
// corpus — see reindexCollections.
//
//   member  — {manifestId, label, thumbnail}. manifestId is always required:
//             it is how a work is found and dropped from a leaf's member list,
//             including on the delete path where there is nothing to re-add.
//   removed — the manifest itself is gone; drop it everywhere, add it nowhere
//   desired — the slugs the work should belong to, as [{slug, label}]
//   leaves  — {slug: document | null} for every slug in the union of the work's
//             current and desired membership. The UNION, never the diff: a diff
//             would short-circuit a retry after a partial failure and leave the
//             projection broken until the next reindex.
function planReconciliation({baseUrl, member, removed = false, desired, root, leaves}) {
  const desiredBySlug = new Map((desired || []).map((entry) => [entry.slug, entry]));
  // The root's existing label wins over a caller-supplied one, so a second
  // curator typing "campus maps" can't retitle a collection the first one named.
  const summaryBySlug = new Map(rootCollectionSummaries(root).map((entry) => [entry.slug, entry]));

  const leafWrites = [];
  // Never populated here any more: reconciliation cannot remove a collection,
  // only empty it. Kept in the plan's shape because applyReconciliation still
  // executes deletes for the explicit DELETE /collections/{slug} route.
  const leafDeletes = [];

  // Sorted, so the plan is a function of its inputs' *values* and not of the
  // order the caller happened to build `leaves` in.
  for (const slug of Object.keys(leaves).sort()) {
    const existing = leaves[slug];
    const keep = membersOf(existing).filter((item) => item.id !== member.manifestId);
    if (!removed && desiredBySlug.has(slug)) {
      keep.push({
        id: member.manifestId,
        label: {none: [member.label]},
        ...(member.thumbnail?.length ? {thumbnail: member.thumbnail} : {}),
      });
    }

    const label = summaryBySlug.get(slug)?.label || desiredBySlug.get(slug)?.label || extractLabel(existing?.label) || slug;
    const members = sortMembers(keep).map((item) => ({
      manifestId: item.id,
      label: extractLabel(item.label),
      thumbnail: item.thumbnail || null,
    }));
    const document = buildCollectionDocument({baseUrl, slug, label, members});

    if (!existing || serializeCollection(existing) !== serializeCollection(document)) {
      leafWrites.push({slug, key: collectionObjectKey(slug), document});
    }
    summaryBySlug.set(slug, {
      slug,
      label,
      thumbnail: document.thumbnail || null,
      itemCount: members.length,
    });
  }

  const collections = [...summaryBySlug.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug),
  );
  const rootNext = buildRootCollectionDocument({baseUrl, collections});
  const rootChanged = !root || serializeCollection(root) !== serializeCollection(rootNext);

  return {leafWrites, leafDeletes, rootNext, rootChanged, collections};
}


function manifestThumbnail(manifest) {
  if (Array.isArray(manifest?.thumbnail) && manifest.thumbnail.length) return manifest.thumbnail;
  const canvasThumbnail = manifest?.items?.[0]?.thumbnail;
  return Array.isArray(canvasThumbnail) && canvasThumbnail.length ? canvasThumbnail : null;
}

module.exports = {
  COLLECTION_PREFIX,
  COLLECTION_OBJECT,
  ROOT_COLLECTION_SLUG,
  ROOT_COLLECTION_LABEL,
  PRESENTATION_CONTEXT,
  STATIC_IIIF_PREFIX,
  STATIC_IIIF_NAMESPACE,
  MANAGED_KEY,
  ITEM_COUNT_KEY,
  MAX_LABEL_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_COLLECTIONS_PER_WORK,
  collectionSlugPattern,
  CollectionNameError,
  sanitizeCollectionLabel,
  sanitizeCollectionSlug,
  collectionObjectKey,
  rootCollectionKey,
  buildCollectionId,
  buildRootCollectionId,
  collectionSlugFromId,
  normalizeContext,
  buildPartOfEntry,
  isManagedPartOfEntry,
  managedCollectionRefs,
  managedCollectionRef,
  foreignPartOfEntries,
  stripForeignManagedEntries,
  applyCollections,
  buildManifestReference,
  buildCollectionReference,
  buildCollectionDocument,
  buildRootCollectionDocument,
  createRootCollectionTemplate,
  rootCollectionSummaries,
  serializeCollection,
  planReconciliation,
  canonicalizeCollectionLabels,
  manifestThumbnail,
  // Exported so the collection import builds its leaf in the same order
  // reconciliation would. "First member" (whose thumbnail the collection
  // borrows) has to mean the same thing however the document was produced,
  // or a reindex would silently change a collection's picture.
  sortMembers,
};
