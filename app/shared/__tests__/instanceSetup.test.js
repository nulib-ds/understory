const test = require("node:test");
const assert = require("node:assert/strict");

const {
  brandingKey,
  buildConfigDocument,
  cacheControlFor,
  contentTypeFor,
  staleKeys,
  uiKey,
} = require("../instanceSetup");

test("UI files keep their paths, except the two the instance owns", () => {
  assert.equal(uiKey("index.html"), "index.html");
  assert.equal(uiKey("collection/work.html"), "collection/work.html");
  assert.equal(uiKey("_next/static/chunks/app.js"), "_next/static/chunks/app.js");
  // What `npm run config` leaves in public/, and so in a local export.
  assert.equal(uiKey("config.json"), null);
  assert.equal(uiKey("branding/theme.css"), null);
  assert.equal(uiKey(".DS_Store"), null);
});

test("branding files go under branding/, without dotfiles, the README or the UI", () => {
  assert.equal(brandingKey("theme.css"), "branding/theme.css");
  assert.equal(brandingKey("assets/logo.svg"), "branding/assets/logo.svg");
  assert.equal(brandingKey("README.md"), null);
  assert.equal(brandingKey("readme"), null);
  // Only the folder's own README: one inside assets/ is just a file.
  assert.equal(brandingKey("assets/README.md"), "branding/assets/README.md");
  assert.equal(brandingKey(".DS_Store"), null);
  assert.equal(brandingKey("assets/.hidden/logo.svg"), null);
  assert.equal(brandingKey("understory-ui/index.html"), null);
});

test("content types are explicit, because the distribution sends nosniff", () => {
  assert.equal(contentTypeFor("branding/theme.css"), "text/css; charset=utf-8");
  assert.equal(contentTypeFor("collection.txt"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("branding/assets/LOGO.SVG"), "image/svg+xml");
  assert.equal(contentTypeFor("_next/static/media/font.woff2"), "font/woff2");
  assert.equal(contentTypeFor("no-extension"), "application/octet-stream");
});

test("only content-hashed assets are cached for ever", () => {
  assert.equal(cacheControlFor("_next/static/chunks/app-abc123.js"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor("index.html"), "no-cache");
  assert.equal(cacheControlFor("config.json"), "no-cache");
  assert.equal(cacheControlFor("branding/theme.css"), "no-cache");
});

test("the config lists the branding files the UI may load, relative to branding/", () => {
  const document = buildConfigDocument(
    {apiUrl: "https://api.example", institutionName: "Acme"},
    ["branding/theme.css", "branding/assets/logo.svg", "branding/header.html"],
  );
  assert.deepEqual(document, {
    apiUrl: "https://api.example",
    institutionName: "Acme",
    brandingFiles: ["assets/logo.svg", "header.html", "theme.css"],
  });
});

test("whatever the deploy did not write is stale", () => {
  assert.deepEqual(
    staleKeys(["index.html", "old.html", "branding/old-logo.svg", "config.json"], ["index.html", "config.json"]),
    ["old.html", "branding/old-logo.svg"],
  );
});
