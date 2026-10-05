// GET /search/{slug}?q=&from=&size= — the search a consuming site calls.
//
// The one unauthenticated way into this stack's data, so it is deliberately
// small and deliberately separate from the manifest API:
//
//   - Reached only through IIIFDistribution. Its Function URL takes AWS_IAM
//     auth and only CloudFront's origin access control can sign for it, so a
//     direct request is a 403 and nothing gets past the cache. The same rule
//     the IIIF bucket follows.
//   - Its own role, which SearchDataAccessPolicy grants read-only access: it can
//     search, never write, delete or move an alias. It has no S3 access at all.
//   - Queries only `{prefix}.{slug}`, the live alias, so it can only ever read
//     what a curator has flipped live. The slug is validated before it goes
//     anywhere near an index expression (publicSearchSlug).
//   - Builds the query itself from a plain string (buildPublishedSearch). No
//     query DSL is accepted.
//
// A collection that does not exist and one that has never been flipped are the
// same 404, so the route cannot be used to enumerate collections.
//
// The first query after ten idle minutes waits ~10s while the search
// collection scales back up from zero. Repeated queries are answered by the
// edge cache without reaching here.

const {
  liveAliasName,
  searchTerm,
  buildPublishedSearch,
  publicSearchSlug,
  publicSearchResults,
} = require("../../../shared/search");
const {search} = require("../../../shared/opensearch");

const prefix = process.env.SEARCH_INDEX_PREFIX || "";

// s-maxage is the edge's copy, and the flip invalidates it, so it bounds only
// how stale results can get if that invalidation fails. max-age is a visitor's
// browser, which no invalidation reaches, so it stays short.
const CACHE_HIT = "public, max-age=60, s-maxage=3600";
const CACHE_MISS = "public, max-age=60, s-maxage=60";

// CORS headers come from IIIFDistribution's response headers policy, which
// overrides the origin's, so none are set here.
function respond(statusCode, payload, cacheControl) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      // Results pages are not content. A crawler that indexed them would only
      // come back to re-query them.
      "X-Robots-Tag": "noindex",
    },
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event) => {
  const method = event?.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") {
    return {statusCode: 204, headers: {"Cache-Control": "public, max-age=3600"}};
  }
  if (method !== "GET" && method !== "HEAD") {
    return respond(405, {error: "Method not allowed"}, "no-store");
  }

  const slug = publicSearchSlug(event?.rawPath);
  if (!slug) {
    return respond(404, {error: "Not found"}, CACHE_MISS);
  }

  const params = event?.queryStringParameters || {};
  const query = buildPublishedSearch(params);
  try {
    const response = await search(liveAliasName(prefix, slug), query);
    if (response === null) {
      return respond(404, {error: "No published search index for this collection"}, CACHE_MISS);
    }
    const page = {q: searchTerm(params.q), from: query.from, size: query.size};
    return respond(200, publicSearchResults(response, page), CACHE_HIT);
  } catch (error) {
    console.error("Public search failed", {slug, error});
    return respond(502, {error: "Search is unavailable"}, "no-store");
  }
};
