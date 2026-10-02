// Signed HTTP against the stack's OpenSearch Serverless (NextGen) collection,
// SearchCollection in template.yml.
//
// Only the published side uses it: the publish run builds each candidate
// index, and the flip route moves the alias. The admin works list used to read
// a working index through here too; it reads the collection documents now
// (worksList.js), so nothing on the save path talks to OpenSearch. Like
// manifest.js this loads the AWS SDK, so it cannot be unit-tested from the repo
// root — keep the naming rules and document shapes in search.js, which is pure,
// and keep this file to IO.
//
// No OpenSearch client library: a signed fetch is the whole requirement, and
// the SDK v3 signer is already a dependency.

const {defaultProvider} = require("@aws-sdk/credential-provider-node");
const {SignatureV4} = require("@smithy/signature-v4");
const {HttpRequest} = require("@smithy/protocol-http");
const {Sha256} = require("@aws-crypto/sha256-js");

const BULK_BATCH_SIZE = 500;

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

// "aoss", not "es": Serverless signs as its own service. The signer also adds
// x-amz-content-sha256 (applyChecksum defaults to true), which Serverless
// requires on every request and a managed domain did not.
//
// OPENSEARCH_ENDPOINT is the collection's own endpoint ({id}.aoss.{region}.on.aws),
// which names the collection in its hostname. The per-account endpoint would
// need an x-amz-aoss-collection-name header on every request instead, signed.
const signer = endpoint
  ? new SignatureV4({
      service: "aoss",
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

// Fails if the index already exists, rather than treating that as success.
// Two publish runs starting in the same instant must not both believe they own
// the candidate; the loser has to find out.
//
// No shard or replica settings: Serverless manages both itself. They were here
// to keep a shared managed domain's shard count down.
async function createIndexExclusive(name, properties) {
  const created = await osRequest("PUT", `/${name}`, JSON.stringify({mappings: {properties}}));
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

// `update` with doc_as_upsert, NOT `index`, so a retried batch merges into
// what an earlier attempt wrote rather than replacing it.
//
// Never asks for a refresh: nothing reads a candidate index until its alias
// flip, so waiting for one per batch would only slow the run.
async function bulkUpsert(index, docs, idOf = (doc) => doc.workId) {
  let indexed = 0;
  let failed = 0;
  for (let i = 0; i < docs.length; i += BULK_BATCH_SIZE) {
    const batch = docs.slice(i, i + BULK_BATCH_SIZE);
    const lines = [];
    for (const doc of batch) {
      lines.push({update: {_index: index, _id: idOf(doc)}});
      lines.push({doc, doc_as_upsert: true});
    }
    const response = await osRequest("POST", "/_bulk", buildBulkBody(lines), "application/x-ndjson");
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

// A multi-action _aliases POST is atomic in OpenSearch: readers never see a
// moment with the alias on neither index, or on both. Serverless supports the
// call (aoss:CreateCollectionItems); that it keeps the atomicity is assumed,
// not yet verified.
async function updateAliases(actions) {
  if (!actions.length) return;
  expectOk(
    await osRequest("POST", "/_aliases", JSON.stringify({actions})),
    "Failed to update aliases",
  );
}

// GET /_alias/{pattern}, as JSON (aoss:DescribeCollectionItems). Not
// _cat/indices, whose Serverless response omits fields and which was already
// avoided on the managed domain, where a scoped policy could deny it.
async function getAliases(pattern) {
  const response = await osRequest("GET", `/_alias/${encodeURIComponent(pattern)}`);
  if (response.status === 404) return {};
  expectOk(response, "Failed to read aliases");
  return response.json || {};
}

// A query against an index or alias. Null when it does not exist, which for
// a live alias means nothing has been flipped live yet: an answer, not a fault.
async function search(index, body) {
  const response = await osRequest("POST", `/${index}/_search`, JSON.stringify(body));
  if (response.status === 404) return null;
  expectOk(response, `Search on ${index} failed`);
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
  createIndexExclusive,
  bulkUpsert,
  updateAliases,
  getAliases,
  search,
  deleteIndex,
};
