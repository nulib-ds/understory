// The working search index: one index per stack, every collection in it,
// filtered by a `collection` term. It is the read model behind the collection
// works list, and it is maintained write-through — every create, save, move and
// delete updates exactly one document in the same request that writes S3.
//
// Rebuildable from S3 in one call, which is why it holds no state that S3 does
// not determine, and why its replica count is 0.

const crypto = require("node:crypto");
const {
  workingIndexName,
  WORKING_INDEX_PROPERTIES,
  buildWorkingDocument,
  SYNC_NEW,
  SYNC_CHANGED,
} = require("../../../shared/search");
const {
  configured,
  ensureIndex,
  bulkUpsert,
  bulkDelete,
  allDocumentIds,
  deleteDocument,
  search,
} = require("../../../shared/opensearch");
const {extractLabel, canvasThumbnailService} = require("../../../shared/manifest");
const {managedCollectionRef} = require("../../../shared/collection");

const prefix = process.env.SEARCH_INDEX_PREFIX || "";
const baseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");

function indexName() {
  return workingIndexName(prefix);
}

// sha256 of the exact bytes written to S3, not of a re-serialization: there is
// no canonical JSON here, and applyCollections reorders keys as a side effect,
// so hashing a round-trip would report changes that are not changes.
function contentHashOf(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

let ensured = false;
async function ensure() {
  if (ensured) return;
  await ensureIndex(indexName(), WORKING_INDEX_PROPERTIES);
  ensured = true;
}

function documentFor(identifier, manifest, {bytes, syncState, importing}) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return buildWorkingDocument({
    workId: identifier,
    manifestUrl: manifest?.id || "",
    label: extractLabel(manifest?.label),
    collection: managedCollectionRef(manifest?.partOf, {baseUrl})?.slug || null,
    // The list shows a stack of five, so there is no point carrying more.
    thumbnails: items.map(canvasThumbnailService).filter(Boolean).slice(0, 5),
    itemCount: items.length,
    contentHash: bytes ? contentHashOf(bytes) : null,
    syncState,
    importing,
  });
}

// Fire-and-forget on the write path, following reconcileQuietly: the manifest
// in S3 is the truth and it has already landed, so failing the caller's save
// because a read model lagged would report failure in the wrong direction.
// POST /collections/{slug}/reindex repairs it.
async function upsertQuietly(identifier, manifest, options = {}) {
  if (!configured || !prefix) return;
  try {
    await ensure();
    // waitFor: false for a write a later one in the same request supersedes;
    // only the LAST write a request makes needs to be searchable on return.
    await bulkUpsert(indexName(), [documentFor(identifier, manifest, options)], undefined, {
      waitFor: options.waitFor !== false,
    });
  } catch (error) {
    console.error(`Failed to index work ${identifier}`, error);
  }
}

async function removeQuietly(identifier) {
  if (!configured || !prefix) return;
  try {
    await deleteDocument(indexName(), identifier);
  } catch (error) {
    console.error(`Failed to remove work ${identifier} from the index`, error);
  }
}

// The collection works list. One query: filter by collection, optionally match
// the title, page with from/size.
async function listWorks({slug, q, from = 0, size = 50}) {
  const term = (q || "").trim();
  const must = term ? [{match: {title: {query: term, fuzziness: "AUTO"}}}] : [{match_all: {}}];
  const body = {
    from,
    size,
    query: {bool: {must, filter: [{term: {collection: slug}}]}},
    // Alphabetical when not searching, by relevance when searching — a filter
    // that reshuffles the whole list on every keystroke is hard to read.
    ...(term ? {} : {sort: [{"title.keyword": "asc"}]}),
    track_total_hits: true,
  };
  const result = await search(indexName(), body);
  const hits = result.hits?.hits || [];
  return {
    total: result.hits?.total?.value ?? hits.length,
    works: hits.map((hit) => ({
      identifier: hit._source?.workId || hit._id,
      label: hit._source?.title || "",
      manifestUrl: hit._source?.manifestId || "",
      thumbnails: hit._source?.thumbnails || [],
      itemCount: hit._source?.itemCount ?? 0,
      syncState: hit._source?.syncState || SYNC_NEW,
      importing: Boolean(hit._source?.importing),
    })),
  };
}

// The publish summary: how many of this collection's works are new, changed or
// already published. One aggregation rather than counting rows the page has
// not loaded.
async function syncCounts(slug) {
  const result = await search(indexName(), {
    size: 0,
    query: {bool: {filter: [{term: {collection: slug}}]}},
    aggs: {states: {terms: {field: "syncState"}}},
  });
  const counts = {new: 0, changed: 0, published: 0};
  for (const bucket of result.aggregations?.states?.buckets || []) {
    if (bucket.key in counts) counts[bucket.key] = bucket.doc_count;
  }
  return counts;
}

// Replace the index contents for the whole stack. Documents whose work no
// longer exists in S3 are removed, so this repairs deletions that failed
// halfway as well as drift.
async function rebuild(docs) {
  if (!configured || !prefix) return {indexed: 0, failed: 0, removed: 0};
  await ensureIndex(indexName(), WORKING_INDEX_PROPERTIES);
  const {indexed, failed} = await bulkUpsert(indexName(), docs);
  const current = new Set(docs.map((doc) => doc.workId));
  const existing = await allDocumentIds(indexName());
  const stale = existing.filter((id) => !current.has(id));
  const removed = await bulkDelete(indexName(), stale);
  return {indexed, failed, removed};
}

module.exports = {
  rebuild,
  indexName,
  contentHashOf,
  documentFor,
  upsertQuietly,
  removeQuietly,
  listWorks,
  syncCounts,
  SYNC_NEW,
  SYNC_CHANGED,
};
