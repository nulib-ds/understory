#!/usr/bin/env node
// Seeds a dev stack with a mock collection of three works described in English
// and French, with `none` values mixed in (scripts/fixtures/multilingual-sample.json),
// for working on the multilingual UI against data that has more than one language.
//
//   AWS_PROFILE=staging-admin node scripts/seed-multilingual-sample.js --stack mat-dev-understory
//
// Writes straight to the stack's IIIF bucket with the AWS CLI, using the same
// shared builders the API uses (app/shared/), so what lands is what the API would
// have written:
//   - each work's manifest, filed in the collection through its partOf;
//   - the collection's leaf document, members hashed from the bytes written;
//   - the collection's entry in the root register, with its languages,
//     written conditionally on the root's ETag so a save elsewhere is not undone.
//
// The works need pictures, and making real ones would mean uploading and
// converting images. Instead each borrows canvases from a work already in the
// stack: the same image services, under the new work's own canvas ids
// (localizeStructuralIds). Deleting a mock work leaves the borrowed images alone,
// because they live under the other work's id.
//
// Re-runnable: the work ids are fixed, so a second run overwrites the same
// objects. Refuses any stack whose name is not a dev stack's (`-dev-`) unless
// --allow-shared is given, so mock data does not land on staging or production
// by accident.

const {execFileSync} = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {WORKING, spaceKey} = require("../app/shared/space");
const {
  PRESENTATION_CONTEXT,
  applyCollections,
  buildCollectionDocument,
  buildRootCollectionDocument,
  collectionObjectKey,
  rootCollectionKey,
  rootCollectionSummaries,
  memberFromManifest,
  membersOf,
} = require("../app/shared/collection");
const {contentHash} = require("../app/shared/publish");
const {localizeStructuralIds} = require("../app/shared/sourceFetch");
const fixture = require("./fixtures/multilingual-sample.json");

function parseArgs(argv) {
  const args = {region: "us-east-1", allowShared: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--stack") args.stack = argv[++i];
    else if (arg === "--region") args.region = argv[++i];
    else if (arg === "--allow-shared") args.allowShared = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.stack) throw new Error("--stack <stack name> is required");
  if (!args.allowShared && !/-dev-/.test(args.stack)) {
    throw new Error(`${args.stack} is not a dev stack; pass --allow-shared to seed it anyway`);
  }
  return args;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "understory-seed-"));

function aws(region, args) {
  const out = execFileSync("aws", [...args, "--region", region, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim() ? JSON.parse(out) : null;
}

// {document, etag}, or null for a key that is not there.
function readJson(region, bucket, key) {
  const file = path.join(tmp, `read-${Math.random().toString(36).slice(2)}.json`);
  try {
    const head = aws(region, ["s3api", "get-object", "--bucket", bucket, "--key", key, file]);
    return {document: JSON.parse(fs.readFileSync(file, "utf8")), etag: head.ETag};
  } catch (error) {
    if (/NoSuchKey|Not Found|404/.test(String(error.stderr || error.message))) return null;
    throw error;
  }
}

// The bytes written are exactly `body`: the hash recorded for a member has to be
// the hash of what is stored, never of a re-serialization.
function writeJson(region, bucket, key, body, {ifMatch} = {}) {
  const file = path.join(tmp, `write-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, body);
  const args = ["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", file];
  args.push("--content-type", "application/json");
  if (ifMatch) args.push("--if-match", ifMatch);
  aws(region, args);
}

const serialize = (document) => JSON.stringify(document, null, 2);
const isImageCanvas = (canvas) =>
  canvas?.items?.[0]?.items?.[0]?.body?.type === "Image";

// Canvases to borrow: image canvases from the first manifests in the stack's
// collections, other than this one. One source manifest per mock work.
function borrowCanvases(region, bucket, root, skipSlug, count) {
  const sources = [];
  for (const summary of rootCollectionSummaries(root)) {
    if (summary.slug === skipSlug) continue;
    const leaf = readJson(region, bucket, collectionObjectKey(summary.slug));
    for (const member of membersOf(leaf?.document)) {
      const key = new URL(member.id).pathname.replace(/^\//, "");
      const manifest = readJson(region, bucket, key)?.document;
      const canvases = (manifest?.items || []).filter(isImageCanvas);
      if (canvases.length) sources.push(canvases);
      if (sources.length === count) return sources;
    }
  }
  return sources;
}

function main() {
  const {stack, region} = parseArgs(process.argv.slice(2));
  const outputs = Object.fromEntries(
    aws(region, ["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs"]).map(
      (output) => [output.OutputKey, output.OutputValue],
    ),
  );
  const bucket = outputs.IIIFBucketName;
  // IIIF_BASE_URL: the base every manifest and collection id is built on.
  const baseUrl = String(outputs.IIIFEndpoint || "").replace(/\/$/, "");
  if (!bucket || !baseUrl) throw new Error(`${stack} has no IIIFBucketName / IIIFEndpoint output`);

  const {slug, label, languages} = fixture.collection;
  const rootRead = readJson(region, bucket, rootCollectionKey());
  if (!rootRead) throw new Error("The stack has no root collection yet; open the UI once first");

  const borrowed = borrowCanvases(region, bucket, rootRead.document, slug, fixture.works.length);
  if (borrowed.length < fixture.works.length) {
    console.warn(
      `Only ${borrowed.length} work(s) with image canvases to borrow from; the rest get none.`,
    );
  }

  const members = fixture.works.map((work, index) => {
    const manifestId = `${baseUrl}/${spaceKey(WORKING, `presentation/manifest/${work.id}/manifest.json`)}`;
    const canvases = (borrowed[index] || []).slice(0, Math.max(work.canvasLabels?.length || 0, 1));
    const items = structuredClone(canvases).map((canvas, i) => ({
      ...canvas,
      ...(work.canvasLabels?.[i] ? {label: work.canvasLabels[i]} : {}),
    }));
    let manifest = {
      "@context": PRESENTATION_CONTEXT,
      id: manifestId,
      type: "Manifest",
      label: work.label,
      ...(work.summary ? {summary: work.summary} : {}),
      ...(work.metadata ? {metadata: work.metadata} : {}),
      ...(work.requiredStatement ? {requiredStatement: work.requiredStatement} : {}),
      items,
    };
    // The borrowed canvases' ids are the source work's; these make them this
    // work's own, the shape every import and upload produces.
    localizeStructuralIds(manifest);
    manifest = applyCollections(manifest, {baseUrl, collections: [{slug, label}]});

    const body = serialize(manifest);
    writeJson(region, bucket, spaceKey(WORKING, `presentation/manifest/${work.id}/manifest.json`), body);
    console.log(`Wrote ${work.id} (${items.length} canvas${items.length === 1 ? "" : "es"})`);
    return memberFromManifest(manifest, {contentHash: contentHash(body)});
  });

  // Leaf before root: the root must never advertise a collection whose document
  // is not there yet.
  const leaf = buildCollectionDocument({baseUrl, slug, label, members, languages});
  writeJson(region, bucket, collectionObjectKey(slug), serialize(leaf));
  console.log(`Wrote the ${slug} collection`);

  // Conditional on the ETag just read, retried on a lost race: a save elsewhere
  // may be rewriting the root at the same moment.
  for (let attempt = 1; ; attempt += 1) {
    const current = attempt === 1 ? rootRead : readJson(region, bucket, rootCollectionKey());
    const collections = [
      ...rootCollectionSummaries(current.document).filter((entry) => entry.slug !== slug),
      {slug, label, thumbnail: leaf.thumbnail || null, itemCount: leaf.items.length, languages},
    ].sort((a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug));
    try {
      writeJson(
        region,
        bucket,
        rootCollectionKey(),
        serialize(buildRootCollectionDocument({baseUrl, collections})),
        {ifMatch: current.etag},
      );
      break;
    } catch (error) {
      if (attempt < 5 && /PreconditionFailed|412|ConditionalRequestConflict|409/.test(String(error.stderr))) continue;
      throw error;
    }
  }
  console.log(`Registered ${slug} in the root, languages: ${languages.join(", ")}`);
}

try {
  main();
} catch (error) {
  console.error(error.stderr ? String(error.stderr).trim() : error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}
