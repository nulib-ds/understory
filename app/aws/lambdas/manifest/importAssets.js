const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const {LambdaClient, InvokeCommand} = require("@aws-sdk/client-lambda");
// One writer, shared with index.js: a private copy here is how the search
// index silently stopped tracking imported works.
const {readManifest, writeManifest} = require("./store");
const {importStatusKey} = require("../../../shared/space");
// The canvas copy itself, shared with the collection import state machine.
const {copyCanvasAsset, copyManifestThumbnail} = require("../../../shared/assetCopy");

const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});
const iiifBucket = process.env.IIIF_BUCKET;

const MAX_CANVAS_INDEX = 1000; // sanity valve against a runaway self-invoke chain
// How many canvases are in flight at once. A sliding window, not a batch: the
// moment one finishes the next starts, so a single slow conversion holds up
// nothing but itself. The slow part of a canvas is waiting on the pyramid
// conversion — which is another Lambda doing the work — so ten wait together
// rather than end to end.
const IMPORT_CONCURRENCY = 10;
// Stop *starting* new canvases after this much elapsed time, leaving room inside
// the 900s timeout to drain what is already in flight (a conversion poll can run
// to POLL_TIMEOUT_MS).
const IMPORT_BUDGET_MS = 600000;
// Phase changes are chatty with ten canvases in flight. Coalesce them; a canvas
// finishing always forces a write, so the status never lags behind reality.
const STATUS_THROTTLE_MS = 400;




// This function holds a manifest in memory for minutes at a time — copyCanvasAsset
// polls up to POLL_TIMEOUT_MS per canvas waiting for the pyramid TIFF — and a
// blind write-back would silently revert anything a curator changed meanwhile
// (a title, a description, collection membership). Re-read immediately before
// writing and carry over only the fields this chain actually owns.
//
// Still not atomic, but the window shrinks from minutes to one S3 round-trip.
// The principled fix is a conditional write on the ETag, which belongs in its
// own change because it touches every writer.
//
// `skipCollection` stays on for the walk's periodic writes; the last one turns
// it off, which is the single collection-entry refresh for the whole walk.
async function writeManifestItems(identifier, manifest, {skipCollection = true} = {}) {
  let current;
  try {
    current = await readManifest(identifier);
  } catch (error) {
    console.error(`Import-assets: could not re-read manifest ${identifier} before write`, error);
    current = manifest;
  }
  current.items = manifest.items;
  // The thumbnail is the walk's to own (no API route writes it), including
  // its REMOVAL: copyManifestThumbnail deletes one it could not copy, and
  // "only if present" would quietly restore the source's link from `current`.
  if (manifest.thumbnail) {
    current.thumbnail = manifest.thumbnail;
  } else {
    delete current.thumbnail;
  }
  await writeManifest(identifier, current, {skipCollection});
}

async function writeImportStatus(identifier, status) {
  await s3.send(
    new PutObjectCommand({
      Bucket: iiifBucket,
      Key: importStatusKey(identifier),
      Body: JSON.stringify({...status, updatedAt: new Date().toISOString()}, null, 2),
      ContentType: "application/json",
    }),
  );
}

async function readImportStatus(identifier) {
  try {
    const response = await s3.send(
      new GetObjectCommand({Bucket: iiifBucket, Key: importStatusKey(identifier)}),
    );
    const text = await response.Body.transformToString();
    return JSON.parse(text);
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
      return {status: "none", total: 0, completed: 0};
    }
    throw error;
  }
}

async function invokeSelf(payload) {
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

// `skipped` is what screenAvCanvases removed before the manifest was written:
// audio/video canvases we could not host, each with its reason. It rides on
// the status object for the whole walk so the work page can say what did not
// come across — and it is why a work whose every canvas was skipped still
// gets a status object, rather than none.
async function triggerAssetImport({identifier, total, skipped = []}) {
  if (!total) {
    if (skipped.length) {
      await writeImportStatus(identifier, {status: "complete", total: 0, completed: 0, skipped});
    }
    return;
  }
  // "in-progress" here is what a publish run reads to hold this work back
  // rather than freeze a half-rewritten manifest, and what the Move route reads
  // to refuse a move that the walk's next write would revert.
  await writeImportStatus(identifier, {status: "in-progress", total, completed: 0, skipped});
  await invokeSelf({action: "importAssets", identifier, canvasIndex: 0});
}

async function resumeAssetImport({identifier}) {
  const status = await readImportStatus(identifier);
  if (status.status !== "in-progress" && status.status !== "failed") {
    return status; // nothing to resume
  }
  const stoppedAt = typeof status.currentIndex === "number" ? status.currentIndex : status.completed || 0;
  // Rewind to the earliest canvas that failed so a retry actually re-attempts it.
  // Canvases already copied are skipped cheaply (copyCanvasAsset no-ops once a
  // canvas points at our own Image API), so re-walking from there costs little.
  const failures = Array.isArray(status.failures) ? status.failures : [];
  const earliestFailure = failures.reduce(
    (min, f) => (typeof f?.canvasIndex === "number" ? Math.min(min, f.canvasIndex) : min),
    Infinity,
  );
  const canvasIndex = Number.isFinite(earliestFailure) ? Math.min(earliestFailure, stoppedAt) : stoppedAt;

  await writeImportStatus(identifier, {
    ...status,
    status: "in-progress",
    currentIndex: canvasIndex,
    failures: [],
    error: undefined,
  });
  await invokeSelf({action: "importAssets", identifier, canvasIndex});
  return readImportStatus(identifier);
}

async function handleImportFailure(event) {
  const identifier = event?.requestPayload?.identifier;
  const canvasIndex = event?.requestPayload?.canvasIndex;
  if (!identifier) {
    console.error("Import-assets: failure record missing identifier", event);
    return;
  }

  const condition = event?.requestContext?.condition || "Unknown";
  const responseError = event?.responsePayload?.errorMessage;
  const error = responseError ? `${condition}: ${responseError}` : condition;

  console.error(`Import-assets: canvas ${canvasIndex} of ${identifier} failed permanently (${error})`);

  const previous = await readImportStatus(identifier);
  await writeImportStatus(identifier, {
    ...previous,
    status: "failed",
    currentIndex: typeof canvasIndex === "number" ? canvasIndex : previous.currentIndex,
    error,
  });
}

async function handleImportAssets({identifier, canvasIndex}) {
  if (!identifier || typeof canvasIndex !== "number" || canvasIndex > MAX_CANVAS_INDEX) {
    console.error("Import-assets: invalid or runaway payload", {identifier, canvasIndex});
    if (identifier) {
      // Leave a terminal record; otherwise the status object is stranded at
      // "in-progress" forever and the UI polls it indefinitely.
      const previous = await readImportStatus(identifier).catch(() => null);
      if (previous && previous.status === "in-progress") {
        await writeImportStatus(identifier, {...previous, status: "failed", error: "Import stopped: invalid state"});
      }
    }
    return;
  }

  let manifest;
  try {
    manifest = await readManifest(identifier);
  } catch (error) {
    console.error(`Import-assets: manifest ${identifier} not found`, error);
    const previous = await readImportStatus(identifier).catch(() => null);
    if (previous && previous.status === "in-progress") {
      await writeImportStatus(identifier, {...previous, status: "failed", error: "Manifest could not be read"});
    }
    return;
  }

  const previousStatus = await readImportStatus(identifier).catch(() => null);
  const failures = Array.isArray(previousStatus?.failures) ? previousStatus.failures : [];
  // Every write below builds a fresh status object, so this has to be carried
  // into each one or the first progress update would erase it.
  const skipped = Array.isArray(previousStatus?.skipped) ? previousStatus.skipped : [];

  const items = Array.isArray(manifest.items) ? manifest.items : [];

  // Progress is per canvas, not a single cursor: with a sliding window, canvas
  // 15 can finish before canvas 11, so "everything below N is done" would be a
  // lie. `done` carries which ones are actually finished and `active` carries
  // what each in-flight canvas is doing right now.
  const done = new Set(
    Array.isArray(previousStatus?.done) ? previousStatus.done.filter((n) => Number.isInteger(n)) : [],
  );
  const active = new Map();

  const startedAt = Date.now();
  let next = Math.max(0, canvasIndex);

  // Writes are serialized through one chain so a slow write can never land after
  // a newer one and resurrect stale progress. The payload is built inside the
  // chain, so every write reflects the state at the moment it actually runs.
  let writeChain = Promise.resolve();
  let lastWriteAt = 0;
  const flushStatus = (force = false) => {
    const now = Date.now();
    if (!force && now - lastWriteAt < STATUS_THROTTLE_MS) return writeChain;
    lastWriteAt = now;
    writeChain = writeChain
      .then(() =>
        writeImportStatus(identifier, {
          status: "in-progress",
          total: items.length,
          completed: done.size,
          currentIndex: next,
          done: [...done].sort((a, b) => a - b),
          active: Object.fromEntries(active),
          failures,
          skipped,
          phase: active.size ? `Copying ${active.size} of ${items.length}…` : null,
        }),
      )
      .catch(() => {});
    return writeChain;
  };

  const running = new Map();
  const runCanvas = async (index) => {
    active.set(index, "Starting…");
    await flushStatus();
    try {
      await copyCanvasAsset({
        identifier,
        canvasIndex: index,
        canvas: items[index],
        onPhase: (phase) => {
          active.set(index, phase);
          return flushStatus();
        },
      });
      // Only a canvas that actually copied counts as done; a failed one stays
      // out so a resume re-attempts it.
      done.add(index);
    } catch (error) {
      console.error(`Import-assets: canvas ${index} of ${identifier} failed`, error);
      failures.push({canvasIndex: index, error: error.message});
    } finally {
      active.delete(index);
      running.delete(index);
      await flushStatus(true);
    }
  };

  const pump = () => {
    while (
      running.size < IMPORT_CONCURRENCY &&
      next < items.length &&
      Date.now() - startedAt < IMPORT_BUDGET_MS
    ) {
      const index = next;
      next += 1;
      running.set(index, runCanvas(index));
    }
  };

  // Refill as each one lands, rather than waiting for a whole batch to clear.
  pump();
  let sinceManifestWrite = 0;
  while (running.size) {
    await Promise.race(running.values());
    sinceManifestWrite += 1;
    // The manifest can be over a megabyte, so write it periodically rather than
    // after every canvas — the in-memory copy is the one being mutated, and the
    // final write below is what makes it durable.
    if (sinceManifestWrite >= IMPORT_CONCURRENCY) {
      sinceManifestWrite = 0;
      await writeManifestItems(identifier, manifest);
    }
    pump();
  }
  await writeManifestItems(identifier, manifest);

  if (next < items.length) {
    // Out of budget with canvases left. Everything below `next` has been
    // attempted and drained, so a fresh invocation picks up cleanly from there.
    await flushStatus(true);
    try {
      await invokeSelf({action: "importAssets", identifier, canvasIndex: next});
    } catch (error) {
      // A dropped handoff is what strands an import at "in-progress" with
      // nothing logged. Say so, and leave a status the UI's stale check
      // surfaces with a Resume button.
      console.error(`Import-assets: could not schedule canvas ${next} for ${identifier}`, error);
      await writeImportStatus(identifier, {
        status: "in-progress",
        total: items.length,
        completed: done.size,
        currentIndex: next,
        done: [...done].sort((a, b) => a - b),
        active: {},
        failures,
        skipped,
        phase: null,
        error: "Import was interrupted — resume to continue.",
      });
    }
    return;
  }

  const finishing = {
    status: "in-progress",
    total: items.length,
    completed: done.size,
    currentIndex: items.length,
    done: [...done].sort((a, b) => a - b),
    active: {},
    failures,
    skipped,
  };
  await writeImportStatus(identifier, {...finishing, phase: "Copying the work's thumbnail…"});
  // The source's own choice of thumbnail, copied as its own image — not a
  // canvas picked on the curator's behalf. See copyManifestThumbnail.
  const thumbnail = await copyManifestThumbnail({
    identifier,
    manifest,
    onPhase: (phase) => writeImportStatus(identifier, {...finishing, phase}).catch(() => {}),
  });
  // The one collection-entry refresh for the whole walk: thumbnails, canvas
  // count and the content hash all settle here.
  //
  // fileNewWork wrote that entry when the work was FILED, which is before this
  // walk had copied anything — so it still carries a thumbnail pointing at the
  // source and a hash of the uncopied manifest. Without this nothing ever came
  // back to correct them.
  await writeManifestItems(identifier, manifest, {skipCollection: false});
  // A canvas that failed to copy still points at the source, so the import is
  // not "complete" just because the walk reached the end.
  await writeImportStatus(identifier, {
    status: failures.length ? "failed" : "complete",
    total: items.length,
    completed: done.size,
    done: [...done].sort((a, b) => a - b),
    active: {},
    failures,
    skipped,
    thumbnail,
    error: failures.length
      ? `${failures.length} of ${items.length} asset${failures.length === 1 ? "" : "s"} could not be copied`
      : undefined,
  });
  console.log(
    `Import-assets: finished ${identifier} with ${failures.length} failure(s) of ${items.length}`,
  );
}

module.exports = {
  triggerAssetImport,
  handleImportAssets,
  readImportStatus,
  resumeAssetImport,
  handleImportFailure,
};
