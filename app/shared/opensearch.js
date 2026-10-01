// Signed HTTP against the OpenSearch domain.
//
// Lifted out of the search Lambda so the manifest API (write-through on save,
// the collection works list) and the publish pipeline share one client. Like
// manifest.js this loads the AWS SDK, so it cannot be unit-tested from the
// repo root — keep the naming rules and document shapes in search.js, which is
// pure, and keep this file to IO.
//
// No OpenSearch client library: a signed fetch is the whole requirement, and
// the SDK v3 signer is already a dependency.

const {defaultProvider} = require("@aws-sdk/credential-provider-node");
const {SignatureV4} = require("@smithy/signature-v4");
const {HttpRequest} = require("@smithy/protocol-http");
const {Sha256} = require("@aws-crypto/sha256-js");

const BULK_BATCH_SIZE = 500;

// OpenSearch is near-real-time: a write is durable immediately but is not
// visible to search until the next refresh, which is 1s by default. Every
// write here is followed almost at once by a read that has to see it — the
// works list after a save, the sync counts the moment a publish run reports
// itself finished — so those writes ask to become searchable before returning.
//
// The cost is up to one refresh interval of added latency, which is the right
// trade: without it the UI shows stale rows and stale counts until something
// makes it re-query a second later, which reads as "the button did nothing".
const WAIT_FOR = {refresh: "wait_for"};

const rawEndpoint = process.env.OPENSEARCH_ENDPOINT || "";

// `new URL("")` throws, and it used to throw at module scope — so a stack
// deployed in the documented "no search index" configuration had a function
// that failed on every cold start with nothing in the UI to explain it.
// Parse lazily and report the misconfiguration instead.
let endpoint = null;
if (rawEndpoint) {
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    console.error(`OPENSEARCH_ENDPOINT is not a URL: ${rawEndpoint}`);
  }
}

const configured = Boolean(endpoint);

const signer = endpoint
  ? new SignatureV4({
      service: "es",
      region: process.env.AWS_REGION,
      credentials: defaultProvider(),
      sha256: Sha256,
    })
  : null;

class OpenSearchError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// `query` is passed separately and never inlined into `path`.
//
// SigV4 signs the canonical URI and the canonical query string as two distinct
// fields. A "?" inside `path` is therefore signed as part of the PATH — it gets
// percent-encoded into the canonical request — while fetch sends it as a real
// query. The signature covers a different request than the one that arrives,
// the domain answers 403, and because the bulk helpers count a non-2xx as a
// failed batch and upsertQuietly swallows failures, the only symptom is that
// nothing ever reaches the index. Hence the guard: this must fail loudly.
async function osRequest(method, path, body, contentType = "application/json", query = undefined) {
  if (!configured) {
    throw new OpenSearchError("Search is not configured for this stack (OPENSEARCH_ENDPOINT)", 503);
  }
  if (path.includes("?")) {
    throw new OpenSearchError(
      `Query string must be passed as \`query\`, not inlined into the path: ${path}`,
      500,
    );
  }
  const request = new HttpRequest({
    method,
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    path,
    ...(query ? {query} : {}),
    headers: {host: endpoint.hostname, "content-type": contentType},
    body,
  });
  const signed = await signer.sign(request);
  const url = new URL(`${endpoint.origin}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {status: response.status, json, text};
}

function expectOk(response, what) {
  if (response.status >= 300) {
    throw new OpenSearchError(`${what}: ${response.status} ${response.text}`, response.status, response.json);
  }
  return response;
}

// Idempotent: adding a property to an existing mapping is allowed. Note that
// existing documents only gain a new field when they are next written, so a
// mapping change is not live until a reindex.
// refresh_interval is set explicitly, not inherited. Every write here waits
// for the next refresh (WAIT_FOR, above), so the interval IS the latency of
// every save — and on a shared domain it is whatever an index template or a
// cluster default says, which this code does not control. An import request,
// which makes several such writes, went from comfortably fast to ~30s and past
// API Gateway's limit. 1s is OpenSearch's own default, and this is a tiny
// index, so pinning it costs the shared cluster nothing it was not already
// designed for.
const DEFAULT_INDEX_SETTINGS = {number_of_shards: 1, number_of_replicas: 0, refresh_interval: "1s"};

async function ensureIndex(name, properties, settings = DEFAULT_INDEX_SETTINGS) {
  const head = await osRequest("HEAD", `/${name}`);
  if (head.status === 200) {
    expectOk(
      await osRequest("PUT", `/${name}/_mapping`, JSON.stringify({properties})),
      `Failed to update mapping for ${name}`,
    );
    // An index created before this, or given another interval by a template,
    // is brought into line — refresh_interval is a dynamic setting. Best
    // effort: failing here must not stop the write that called ensure, and a
    // permission the shared domain withholds would otherwise do exactly that.
    if (settings.refresh_interval) {
      const updated = await osRequest(
        "PUT",
        `/${name}/_settings`,
        JSON.stringify({index: {refresh_interval: settings.refresh_interval}}),
      ).catch((error) => ({status: 0, text: error.message}));
      if (updated.status >= 300 || updated.status === 0) {
        console.warn(`Could not set refresh_interval on ${name}: ${updated.status} ${updated.text}`);
      }
    }
    return false;
  }
  expectOk(
    await osRequest("PUT", `/${name}`, JSON.stringify({settings, mappings: {properties}})),
    `Failed to create index ${name}`,
  );
  return true;
}

// Fails if the index already exists, rather than treating that as success.
// Two publish runs starting in the same instant must not both believe they own
// the candidate; the loser has to find out.
async function createIndexExclusive(name, properties, settings) {
  const created = await osRequest(
    "PUT",
    `/${name}`,
    JSON.stringify({settings: settings || {number_of_shards: 1, number_of_replicas: 0}, mappings: {properties}}),
  );
  if (created.status >= 300) {
    const type = created.json?.error?.type;
    if (type === "resource_already_exists_exception") {
      throw new OpenSearchError(`Index already exists: ${name}`, 409, created.json);
    }
    throw new OpenSearchError(`Failed to create index ${name}: ${created.status} ${created.text}`, created.status);
  }
  return true;
}

function buildBulkBody(lines) {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

// `update` with doc_as_upsert, NOT `index`. `index` replaces the whole
// document, so two writers racing on the same work — a save and the publish
// run's sync-state write — would clobber each other's fields rather than
// merging.
async function bulkUpsert(index, docs, idOf = (doc) => doc.workId, {waitFor = true} = {}) {
  let indexed = 0;
  let failed = 0;
  for (let i = 0; i < docs.length; i += BULK_BATCH_SIZE) {
    const batch = docs.slice(i, i + BULK_BATCH_SIZE);
    const lines = [];
    for (const doc of batch) {
      lines.push({update: {_index: index, _id: idOf(doc)}});
      lines.push({doc, doc_as_upsert: true});
    }
    const response = await osRequest(
      "POST",
      "/_bulk",
      buildBulkBody(lines),
      "application/x-ndjson",
      waitFor ? WAIT_FOR : undefined,
    );
    if (response.status >= 300) {
      failed += batch.length;
      console.error("Bulk upsert batch failed", response.status, response.text);
      continue;
    }
    for (const item of response.json?.items || []) {
      const result = item.update || item.index || item.create || {};
      if (result.status && result.status >= 300) failed += 1;
      else indexed += 1;
    }
  }
  return {indexed, failed};
}

// Bulk scripted update. Unlike bulkUpsert this can read the stored document
// before deciding, which is what makes a guarded write possible: a save that
// landed while a publish run was walking must stay "changed" rather than being
// quietly marked published.
async function bulkScriptedUpdate(index, updates, {waitFor = true} = {}) {
  if (!updates.length) return {updated: 0, failed: 0};
  let updated = 0;
  let failed = 0;
  for (let i = 0; i < updates.length; i += BULK_BATCH_SIZE) {
    const batch = updates.slice(i, i + BULK_BATCH_SIZE);
    const lines = [];
    for (const entry of batch) {
      lines.push({update: {_index: index, _id: entry.id}});
      lines.push({script: entry.script});
    }
    const response = await osRequest(
      "POST",
      "/_bulk",
      buildBulkBody(lines),
      "application/x-ndjson",
      waitFor ? WAIT_FOR : undefined,
    );
    if (response.status >= 300) {
      failed += batch.length;
      console.error("Bulk scripted update failed", response.status, response.text);
      continue;
    }
    for (const item of response.json?.items || []) {
      const result = item.update || {};
      if (result.status && result.status >= 300) failed += 1;
      else updated += 1;
    }
  }
  return {updated, failed};
}


async function bulkDelete(index, ids) {
  if (!ids.length) return 0;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BULK_BATCH_SIZE) {
    const batch = ids.slice(i, i + BULK_BATCH_SIZE);
    const lines = batch.map((id) => ({delete: {_index: index, _id: id}}));
    const response = await osRequest("POST", "/_bulk", buildBulkBody(lines), "application/x-ndjson");
    if (response.status >= 300) {
      console.error("Bulk delete batch failed", response.status, response.text);
      continue;
    }
    deleted += batch.length;
  }
  return deleted;
}

async function deleteDocument(index, id) {
  const response = await osRequest(
    "DELETE",
    `/${index}/_doc/${encodeURIComponent(id)}`,
    undefined,
    "application/json",
    WAIT_FOR,
  );
  // 404 means it was never indexed, which is the state we wanted anyway.
  if (response.status >= 300 && response.status !== 404) {
    throw new OpenSearchError(`Failed to delete ${id}: ${response.status} ${response.text}`, response.status);
  }
  return response.status === 200;
}

async function search(index, body) {
  const response = await osRequest("POST", `/${index}/_search`, JSON.stringify(body));
  // A collection whose index has not been written to yet is empty, not broken.
  if (response.status === 404) return {hits: {hits: [], total: {value: 0}}, aggregations: {}};
  expectOk(response, `Search on ${index} failed`);
  return response.json || {};
}

// Every id in the index, paged with search_after. Used by the repair path to
// find documents whose work no longer exists in S3.
async function allDocumentIds(index, filter) {
  const ids = [];
  let searchAfter;
  for (;;) {
    const body = {
      size: 1000,
      sort: [{_id: "asc"}],
      _source: false,
      query: filter || {match_all: {}},
      ...(searchAfter ? {search_after: searchAfter} : {}),
    };
    const response = await osRequest("POST", `/${index}/_search`, JSON.stringify(body));
    if (response.status === 404) break;
    expectOk(response, `Failed to list ids in ${index}`);
    const hits = response.json?.hits?.hits || [];
    if (!hits.length) break;
    for (const hit of hits) ids.push(hit._id);
    searchAfter = hits[hits.length - 1].sort;
    if (hits.length < 1000) break;
  }
  return ids;
}

// A multi-action _aliases POST is atomic on AWS OpenSearch Service: readers
// never see a moment with the alias on neither index, or on both.
async function updateAliases(actions) {
  if (!actions.length) return;
  expectOk(
    await osRequest("POST", "/_aliases", JSON.stringify({actions})),
    "Failed to update aliases",
  );
}

// GET /_alias/{pattern}, as JSON. Deliberately not _cat/indices: that is a
// cluster-monitor API a scoped resource policy or fine-grained access control
// can deny, and this only needs index-level rights.
async function getAliases(pattern) {
  const response = await osRequest("GET", `/_alias/${encodeURIComponent(pattern)}`);
  if (response.status === 404) return {};
  expectOk(response, "Failed to read aliases");
  return response.json || {};
}

async function deleteIndex(name) {
  const response = await osRequest("DELETE", `/${name}`);
  if (response.status >= 300 && response.status !== 404) {
    throw new OpenSearchError(`Failed to delete index ${name}: ${response.status} ${response.text}`, response.status);
  }
}

module.exports = {
  configured,
  OpenSearchError,
  osRequest,
  ensureIndex,
  createIndexExclusive,
  bulkUpsert,
  bulkScriptedUpdate,
  bulkDelete,
  deleteDocument,
  search,
  allDocumentIds,
  updateAliases,
  getAliases,
  deleteIndex,
};
