const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// AdminRouterFunction is a CloudFront Function, inline in template.yml, so the
// test runs the code from there rather than from a module of its own.
function loadHandler() {
  const template = fs.readFileSync(path.join(__dirname, "..", "template.yml"), "utf8");
  const resource = template.indexOf("\n  AdminRouterFunction:");
  const start = template.indexOf("FunctionCode: |", resource);
  assert.ok(resource >= 0 && start >= 0, "AdminRouterFunction's FunctionCode not found in template.yml");
  const body = [];
  for (const line of template.slice(start).split("\n").slice(1)) {
    if (line.trim() && !line.startsWith("        ")) break;
    body.push(line.slice(8));
  }
  return new Function(`${body.join("\n")}\nreturn handler;`)();
}

const handler = loadHandler();

// What the edge does with a path: a redirect's location, or the S3 key it asks for.
function route(uri) {
  const result = handler({request: {uri}});
  return result.statusCode ? {redirect: result.headers.location.value} : {uri: result.uri};
}

test("a page's data file passes through, never mistaken for a slug", () => {
  // Next.js fetches these on every in-app move to the page.
  assert.deepEqual(route("/collection/work.txt"), {uri: "/collection/work.txt"});
  assert.deepEqual(route("/collection/search.txt"), {uri: "/collection/search.txt"});
  assert.deepEqual(route("/collection.txt"), {uri: "/collection.txt"});
  assert.deepEqual(route("/index.txt"), {uri: "/index.txt"});
});

test("pages are served from their .html files", () => {
  assert.deepEqual(route("/"), {uri: "/"});
  assert.deepEqual(route("/users"), {uri: "/users.html"});
  assert.deepEqual(route("/users/"), {uri: "/users.html"});
  assert.deepEqual(route("/collection"), {uri: "/collection.html"});
  assert.deepEqual(route("/collection/work"), {uri: "/collection/work.html"});
  assert.deepEqual(route("/collection/search"), {uri: "/collection/search.html"});
  assert.deepEqual(route("/_next/static/chunks/app.js"), {uri: "/_next/static/chunks/app.js"});
});

test("the old path-shaped links redirect to their query-string pages", () => {
  assert.deepEqual(route("/collections"), {redirect: "/"});
  assert.deepEqual(route("/collection/maps-2024"), {redirect: "/collection?slug=maps-2024"});
  assert.deepEqual(route("/collection/maps-2024/"), {redirect: "/collection?slug=maps-2024"});
  assert.deepEqual(route("/collection/maps-2024/search"), {redirect: "/collection/search?slug=maps-2024"});
  assert.deepEqual(route("/collection/maps-2024/work/abc-123"), {
    redirect: "/collection/work?slug=maps-2024&id=abc-123",
  });
});

test("a collection named work or search is reached the new way only", () => {
  assert.deepEqual(route("/collection/work/search"), {uri: "/collection/work/search.html"});
  assert.deepEqual(route("/collection/search/work/abc"), {redirect: "/collection/work?slug=search&id=abc"});
});

test("a redirect is kept by browsers for a day, not indefinitely", () => {
  // A 301 without Cache-Control is kept indefinitely, so a wrong one would
  // outlive its fix in every browser that saw it.
  for (const uri of ["/collections", "/collection/maps-2024", "/collection/maps-2024/search", "/collection/maps-2024/work/abc-123"]) {
    const result = handler({request: {uri}});
    assert.equal(result.statusCode, 301, uri);
    assert.equal(result.headers["cache-control"]?.value, "max-age=86400", uri);
  }
});
