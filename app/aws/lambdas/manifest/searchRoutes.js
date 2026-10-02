// GET /collections/{slug}/search — query a collection's LIVE search index, the
// one a consuming site would get, through the API.
//
// It exists so a curator (or a developer) can see what publishing put there
// without needing access to the search collection themselves: Serverless only
// answers this stack's own role, and this route runs as that role. Unlinked
// in the UI for now (/collection/{slug}/search); the deliberate way to inspect
// and manage indexes is still to be designed.
//
// It wakes the collection like any search request, so the first query after it
// has been idle takes ~10s. The page queries on submit, never per keystroke.

const {jsonResponse} = require("./http");
const {canViewCollection} = require("../../../shared/access");
const {rootCollectionSummaries} = require("../../../shared/collection");
const {aliasStateKey} = require("../../../shared/space");
const {liveAliasName, buildPublishedSearch, publishedSearchResults} = require("../../../shared/search");
const {search} = require("../../../shared/opensearch");
const {ensureRoot, readJson} = require("./collectionStore");

const prefix = process.env.SEARCH_INDEX_PREFIX || "";

async function handleSearchRoute({method, segments, principal, event}) {
  if (method !== "GET") {
    return jsonResponse(405, {error: "Method not allowed"});
  }
  const slug = decodeURIComponent(segments[1]);
  if (!canViewCollection(principal, slug)) {
    return jsonResponse(403, {error: "You do not have access to this collection"});
  }
  try {
    const [root, aliases] = await Promise.all([ensureRoot(), readJson(aliasStateKey(slug))]);
    const known = rootCollectionSummaries(root).find((entry) => entry.slug === slug);
    if (!known) {
      return jsonResponse(404, {error: `No collection called "${slug}"`});
    }
    const params = event.queryStringParameters || {};
    const alias = liveAliasName(prefix, slug);
    const response = await search(alias, buildPublishedSearch(params));
    return jsonResponse(200, {
      collection: {slug, label: known.label},
      alias,
      // Which run's index the alias names, from the panel's copy: there to
      // say which publish the results came from.
      liveIndex: aliases?.liveIndex || null,
      // False when the alias does not exist: nothing has been flipped live.
      published: response !== null,
      q: String(params.q || ""),
      ...publishedSearchResults(response),
    });
  } catch (error) {
    console.error("Collection search failed", error);
    return jsonResponse(500, {error: "Unable to search this collection"});
  }
}

module.exports = {handleSearchRoute};
