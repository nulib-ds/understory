#!/usr/bin/env node
// Points `npm run dev` at a deployed stack: copies the stack's /config.json and
// branding files into public/, where the dev server serves them at the same
// paths the deployed UI reads.
//
//   npm run config -- <stack-name> [--profile <aws-profile>]
//
// Reads the stack's AdminUrl output with the AWS CLI, then fetches the files
// from that address. Both written paths are gitignored.
import {execFileSync} from "node:child_process";
import {mkdirSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const args = process.argv.slice(2);
const stack = args.find((arg) => !arg.startsWith("--"));
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1] : null;
if (!stack) {
  console.error("Usage: npm run config -- <stack-name> [--profile <aws-profile>]");
  process.exit(1);
}

const cli = ["cloudformation", "describe-stacks", "--stack-name", stack,
  "--query", "Stacks[0].Outputs[?OutputKey=='AdminUrl'].OutputValue", "--output", "text"];
if (profile) cli.push("--profile", profile);
const adminUrl = execFileSync("aws", cli, {encoding: "utf8"}).trim().replace(/\/+$/, "");
if (!adminUrl || adminUrl === "None") {
  console.error(`${stack} has no AdminUrl output. Is it deployed from this version of the template?`);
  process.exit(1);
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

async function fetchOk(url) {
  const response = await fetch(url, {cache: "no-store"});
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

const config = await (await fetchOk(`${adminUrl}/config.json`)).json();
writeFileSync(join(publicDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`public/config.json from ${adminUrl}`);

const brandingDir = join(publicDir, "branding");
rmSync(brandingDir, {recursive: true, force: true});
for (const path of config.brandingFiles || []) {
  const target = join(brandingDir, path);
  mkdirSync(dirname(target), {recursive: true});
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  writeFileSync(target, Buffer.from(await (await fetchOk(`${adminUrl}/branding/${encoded}`)).arrayBuffer()));
  console.log(`public/branding/${path}`);
}
