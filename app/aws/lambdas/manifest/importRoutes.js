// The three collection-import endpoints: look at a source, start a run, watch it.
//
// The run itself is ImportStateMachine (see app/aws/lambdas/import/); this only
// starts it and reports on it. Modelled on publishRoutes.js, down to the
// conditional write that serves as the run mutex.
//
// `ensureRoot` arrives as a parameter rather than a require. collections.js
// dispatches here, so requiring it back would be a cycle — the same reason
// fileNewWork takes `writeManifest` as an argument.
const crypto = require("node:crypto");
const {SFNClient, StartExecutionCommand, DescribeExecutionCommand} = require("@aws-sdk/client-sfn");
const {jsonResponse, parseBody} = require("./http");
const {canManageCollections, canViewCollection} = require("../../../shared/access");
const {INTERNAL_PREFIX} = require("../../../shared/space");
const {progressStates} = require("../../../shared/importProgress");
const {
  CollectionNameError,
  sanitizeCollectionLabel,
  sanitizeCollectionSlug,
  collectionObjectKey,
  rootCollectionKey,
  buildCollectionDocument,
  buildRootCollectionDocument,
  rootCollectionSummaries,
} = require("../../../shared/collection");
const {extractLabel} = require("../../../shared/language");
const {
  ImportError,
  validateSourceUrl,
  fetchSourceDocument,
  collectionMembers,
} = require("../../../shared/sourceFetch");
const {readJson, putJson, listKeys} = require("./publishStore");

const sfn = new SFNClient({});
const stateMachineArn = process.env.IMPORT_STATE_MACHINE_ARN || "";
const baseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");

// Kept in step with BATCH_SIZE in app/aws/lambdas/import/index.js. Only used to
// turn a count of finished batches into an approximate work count for the
// progress bar, so a drift would misreport progress, never corrupt a run.
const BATCH_SIZE = 10;

const statusKeyFor = (slug) => `${INTERNAL_PREFIX}/collection-import/${slug}/status.json`;
const worksPrefix = (slug, runId) => `${INTERNAL_PREFIX}/collection-import/${slug}/${runId}/works/`;
const progressPrefix = (slug, runId) => `${INTERNAL_PREFIX}/collection-import/${slug}/${runId}/progress/`;
const planKeyFor = (slug, runId) => `${INTERNAL_PREFIX}/collection-import/${slug}/${runId}/plan.json`;

function executionArnFor(slug, runId) {
  if (!stateMachineArn) return null;
  const name = `import-${slug}-${runId}`.slice(0, 80);
  return `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}`;
}

// A run that died without writing a terminal status would otherwise read as
// "running" forever. The execution name is deterministic, so its ARN is
// derivable and reality can be consulted. Straight from publishRoutes.
async function readStatus(slug) {
  const stored = await readJson(statusKeyFor(slug));
  const status = stored?.document || {status: "idle"};
  if (status.status !== "running" || !status.runId) return status;

  const executionArn = executionArnFor(slug, status.runId);
  if (!executionArn) return status;
  try {
    const live = await sfn.send(new DescribeExecutionCommand({executionArn}));
    if (live.status === "RUNNING") return status;
    return {
      ...status,
      status: live.status === "SUCCEEDED" ? "complete" : "failed",
      error:
        status.error ||
        `The run ended as ${live.status} without reporting a result. Its execution is in the Step Functions console.`,
      reconciled: true,
    };
  } catch (error) {
    if (error?.name === "ExecutionDoesNotExist") {
      return {...status, status: "failed", error: "The run never started.", reconciled: true};
    }
    console.error("Describe import execution failed", error);
    return status;
  }
}

// Progress comes from two listings in S3, each one ListObjectsV2 per thousand
// keys however big the run: the batch result objects (one per ten works) and the
// per-work markers (shared/importProgress.js). Nothing contends, and a page
// reload picks the run back up.
//
// `states` is one character per planned work, in plan order — a few kilobytes
// for thousands of works, which is why it rides on every poll while the plan
// itself (labels, ids) is fetched once, from the route below.
async function readProgress(status) {
  if (!status.runId || !status.total) return status;
  try {
    const [batchKeys, markerKeys] = await Promise.all([
      listKeys(worksPrefix(status.slug, status.runId)),
      listKeys(progressPrefix(status.slug, status.runId)),
    ]);
    const states = progressStates(status.total, markerKeys);
    // A work is finished once it is anything but queued or importing. Exact,
    // unlike the batch count, which only moves in tens.
    const finished = [...states].filter((char) => char !== "q" && char !== "i").length;
    const approximate = Math.min(batchKeys.length * BATCH_SIZE, status.total);
    return {
      ...status,
      batchesDone: batchKeys.length,
      completed: status.completed ?? (markerKeys.length ? finished : approximate),
      states,
    };
  } catch (error) {
    console.error("Read import progress failed", error);
    return status;
  }
}

async function handleCollectionImportRoute({method, segments, principal, event, ensureRoot}) {
  // GET /collections/{slug}/import
  if (method === "GET" && segments.length === 3 && segments[2] === "import") {
    const slug = decodeURIComponent(segments[1]);
    if (!canViewCollection(principal, slug)) {
      return jsonResponse(403, {error: "You do not have access to this collection"});
    }
    try {
      return jsonResponse(200, await readProgress(await readStatus(slug)));
    } catch (error) {
      console.error("Read import status failed", error);
      return jsonResponse(500, {error: "Unable to read import status"});
    }
  }

  // GET /collections/{slug}/import/plan — the current run's works, in plan order,
  // so the page can draw every row before any of them has landed. Pairs with the
  // `states` string on the status route: character N of `states` is work N here.
  // Only {workId, label}: sourceUrl is the source's business, not the page's.
  if (method === "GET" && segments.length === 4 && segments[2] === "import" && segments[3] === "plan") {
    const slug = decodeURIComponent(segments[1]);
    if (!canViewCollection(principal, slug)) {
      return jsonResponse(403, {error: "You do not have access to this collection"});
    }
    try {
      const status = (await readJson(statusKeyFor(slug)))?.document;
      if (!status?.runId) return jsonResponse(200, {runId: null, works: []});
      const plan = (await readJson(planKeyFor(slug, status.runId)))?.document;
      return jsonResponse(200, {
        runId: status.runId,
        works: (plan?.works || []).map((work) => ({workId: work.workId, label: work.label})),
      });
    } catch (error) {
      console.error("Read import plan failed", error);
      return jsonResponse(500, {error: "Unable to read the import plan"});
    }
  }

  // POST /collections/import/preview — look at the source, write nothing.
  //
  // Returns a SUMMARY, not the document. The work import round-trips the whole
  // manifest through the browser; a Collection cannot, because at a few hundred
  // bytes a member a large one exceeds Lambda's 6MB response cap. Plan re-fetches
  // it server-side instead.
  if (method === "POST" && segments.length === 3 && segments[1] === "import" && segments[2] === "preview") {
    if (!canManageCollections(principal)) {
      return jsonResponse(403, {error: "Only an administrator can import a collection"});
    }
    try {
      const body = parseBody(event);
      const sourceUrl = validateSourceUrl(body.sourceUrl, {noun: "collection"});
      const collection = await fetchSourceDocument(sourceUrl, {expect: "Collection"});
      const {manifests, skippedCollections} = collectionMembers(collection);
      return jsonResponse(200, {
        label: extractLabel(collection.label),
        itemCount: manifests.length,
        skippedCollections,
        // A plain derivative URL, NOT an image service id: sources commonly
        // expose a collection thumbnail with no service behind it, so the UI
        // renders this as-is rather than building a IIIF request from it.
        thumbnailUrl: collection.thumbnail?.[0]?.id || manifests[0]?.thumbnail?.[0]?.id || null,
        sourceUrl,
      });
    } catch (error) {
      if (error instanceof ImportError) return jsonResponse(error.status, {error: error.message});
      if (error.message === "Invalid JSON payload") return jsonResponse(400, {error: error.message});
      console.error("Collection import preview failed", error);
      return jsonResponse(500, {error: "Unable to preview that collection"});
    }
  }

  // POST /collections/import — create the collection, start the run.
  if (method === "POST" && segments.length === 2 && segments[1] === "import") {
    if (!canManageCollections(principal)) {
      return jsonResponse(403, {error: "Only an administrator can import a collection"});
    }
    if (!stateMachineArn) {
      return jsonResponse(503, {error: "Collection import is not configured for this stack"});
    }
    try {
      const body = parseBody(event);
      const sourceUrl = validateSourceUrl(body.sourceUrl, {noun: "collection"});
      // Two independent fields, exactly as POST /collections. The UI prefills the
      // id from the fetched label; the server validates what it is handed and
      // still never derives one from the other.
      const label = sanitizeCollectionLabel(body.label);
      const slug = sanitizeCollectionSlug(body.slug);

      const root = await ensureRoot();
      const summaries = rootCollectionSummaries(root);
      if (summaries.some((entry) => entry.slug === slug)) {
        return jsonResponse(409, {error: `The id "${slug}" is already taken`});
      }

      const current = await readStatus(slug);
      if (current.status === "running") {
        return jsonResponse(409, {error: "An import is already running for this collection"});
      }

      // The collection is created EMPTY and up front, so it exists in the root
      // register from the moment the button is pressed and the curator can watch
      // it fill. `items: []` is what the spec allows and what makes this a real,
      // resolvable document immediately — an admin-created collection is allowed
      // to have no members, so this is a valid state, not a placeholder.
      const document = buildCollectionDocument({baseUrl, slug, label, members: []});
      await putJson(collectionObjectKey(slug), document);
      const collections = [...summaries, {slug, label, thumbnail: null, itemCount: 0}].sort(
        (a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug),
      );
      await putJson(rootCollectionKey(), buildRootCollectionDocument({baseUrl, collections}));

      const runId = crypto.randomBytes(6).toString("hex");
      // Claim the run before starting it: a conditional write is the mutex, so
      // two concurrent starts cannot both win.
      await putJson(
        statusKeyFor(slug),
        {slug, runId, sourceUrl, status: "running", total: null, startedAt: new Date().toISOString()},
        current.status === "idle" ? {IfNoneMatch: "*"} : {IfMatch: current.etag},
      );
      await sfn.send(
        new StartExecutionCommand({
          stateMachineArn,
          name: `import-${slug}-${runId}`.slice(0, 80),
          input: JSON.stringify({slug, runId, sourceUrl, requestedBy: principal?.email || null}),
        }),
      );

      return jsonResponse(202, {
        collection: {slug, label, id: document.id, itemCount: 0, thumbnail: null},
        collections,
        runId,
        status: "running",
      });
    } catch (error) {
      if (error instanceof CollectionNameError) return jsonResponse(400, {error: error.message});
      if (error instanceof ImportError) return jsonResponse(error.status, {error: error.message});
      if (error.message === "Invalid JSON payload") return jsonResponse(400, {error: error.message});
      if (error?.name === "PreconditionFailed" || error?.$metadata?.httpStatusCode === 412) {
        return jsonResponse(409, {error: "An import is already running for this collection"});
      }
      console.error("Start collection import failed", error);
      return jsonResponse(500, {error: "Unable to start the import"});
    }
  }

  return jsonResponse(405, {error: "Method not allowed"});
}

module.exports = {handleCollectionImportRoute};
