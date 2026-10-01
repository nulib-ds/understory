const test = require("node:test");
const assert = require("node:assert/strict");

const {regionSize, fitSize, safeImageRequest} = require("../imageRequest");

const SERVICE = "https://images.example/iiif/3/image%2Fw%2F1";

test("regionSize: full, square, pixel and percent regions", () => {
  const full = {width: 2326, height: 2295};
  assert.deepEqual(regionSize("full", full), full);
  assert.deepEqual(regionSize("square", full), {width: 2295, height: 2295});
  assert.deepEqual(regionSize("100,100,500,400", full), {width: 500, height: 400});
  // Clamped to the image: a region running off the edge is only what exists.
  assert.deepEqual(regionSize("2000,2000,500,500", full), {width: 326, height: 295});
  assert.deepEqual(regionSize("pct:0,0,50,50", full), {width: 1163, height: 1148});
});

// The two cases our v3 server refuses, both of them downscales.
test("fitSize turns !w,h into an exact width, never a box wider than the image", () => {
  // NUL's poster: 320x240 in a 300x300 box.
  assert.deepEqual(fitSize("!300,300", {width: 320, height: 240}), {size: "300,", width: 300, height: 225});
  // Measured on our own /iiif/3: !3000,2000 on 2326x2295 is refused.
  assert.deepEqual(fitSize("!3000,2000", {width: 2326, height: 2295}), {size: "2027,", width: 2027, height: 2000});
});

test("fitSize never upscales, and says max when the answer is the whole region", () => {
  assert.deepEqual(fitSize("600,", {width: 320, height: 240}), {size: "max", width: 320, height: 240});
  assert.deepEqual(fitSize("^!1000,1000", {width: 320, height: 240}), {size: "max", width: 320, height: 240});
  assert.deepEqual(fitSize(",120", {width: 320, height: 240}), {size: "160,", width: 160, height: 120});
  assert.deepEqual(fitSize("pct:50", {width: 320, height: 240}), {size: "160,", width: 160, height: 120});
  assert.deepEqual(fitSize("full", {width: 320, height: 240}), {size: "max", width: 320, height: 240});
  assert.equal(fitSize("!300,300", {width: 0, height: 0}), null);
});

test("safeImageRequest keeps region and rotation, and writes a safe size", () => {
  const full = {width: 320, height: 240};
  assert.deepEqual(
    safeImageRequest("https://iiif.nul.edu/iiif/3/posters/x/full/!300,300/0/default.jpg", {serviceId: SERVICE, full}),
    {url: `${SERVICE}/full/300,/0/default.jpg`, width: 300, height: 225},
  );
  assert.deepEqual(
    safeImageRequest("https://iiif.nul.edu/iiif/3/x/square/!100,100/90/default.jpg", {serviceId: SERVICE, full}),
    {url: `${SERVICE}/square/100,/90/default.jpg`, width: 100, height: 100},
  );
  // A v2-style "full" size becomes v3's "max".
  assert.equal(
    safeImageRequest("https://iiif.other.org/iiif/2/x/full/full/0/default.jpg", {serviceId: SERVICE, full}).url,
    `${SERVICE}/full/max/0/default.jpg`,
  );
});

test("safeImageRequest falls back to max when it cannot fit", () => {
  // Not an Image API request at all (NUL's plain /thumbnail endpoint).
  assert.equal(
    safeImageRequest("https://api.nul.edu/works/x/thumbnail", {serviceId: SERVICE, full: {width: 10, height: 10}}).url,
    `${SERVICE}/full/max/0/default.jpg`,
  );
  // Our size unknown: max is the one size that is always safe.
  assert.deepEqual(safeImageRequest("https://x/iiif/3/y/full/!300,300/0/default.jpg", {serviceId: SERVICE}), {
    url: `${SERVICE}/full/max/0/default.jpg`,
    width: null,
    height: null,
  });
});
