const test = require("node:test");
const assert = require("node:assert/strict");

const {progressKey, parseProgressKey, progressStates, countStates} = require("../importProgress");

const PREFIX = "internal/collection-import/c/run1/";

test("a marker key round-trips through parse", () => {
  const key = progressKey(PREFIX, 12, "partial");
  assert.equal(key, `${PREFIX}progress/12.partial`);
  assert.deepEqual(parseProgressKey(key), {index: 12, state: "partial"});
});

test("queued is the absence of a marker, never a key", () => {
  assert.throws(() => progressKey(PREFIX, 0, "queued"));
  assert.equal(parseProgressKey(`${PREFIX}progress/0.queued`), null);
});

test("things that are not markers are ignored", () => {
  assert.equal(parseProgressKey(`${PREFIX}works/3.json`), null);
  assert.equal(parseProgressKey(`${PREFIX}progress/x.ok`), null);
  assert.equal(parseProgressKey(`${PREFIX}progress/2.nonsense`), null);
  assert.equal(parseProgressKey(undefined), null);
});

test("every planned work gets a character, queued where nothing has happened", () => {
  assert.equal(progressStates(5, []), "qqqqq");
  assert.equal(progressStates(0, []), "");
  assert.equal(progressStates(3, undefined), "qqq");
});

test("the furthest state wins, whatever order the keys arrive in", () => {
  const keys = [
    progressKey(PREFIX, 0, "ok"),
    progressKey(PREFIX, 0, "importing"),
    progressKey(PREFIX, 1, "importing"),
    progressKey(PREFIX, 2, "failed"),
    progressKey(PREFIX, 2, "importing"),
    progressKey(PREFIX, 3, "partial"),
    progressKey(PREFIX, 4, "deferred"),
  ];
  assert.equal(progressStates(6, keys), "oifwdq");
  assert.equal(progressStates(6, [...keys].reverse()), "oifwdq");
});

test("a re-run can only move a work forward", () => {
  const keys = [progressKey(PREFIX, 0, "failed"), progressKey(PREFIX, 0, "ok")];
  assert.equal(progressStates(1, keys), "o");
});

test("markers past the plan are ignored", () => {
  assert.equal(progressStates(2, [progressKey(PREFIX, 9, "ok")]), "qq");
});

test("counts add up to the plan", () => {
  const counts = countStates("oowfdiqq");
  assert.deepEqual(counts, {queued: 2, importing: 1, deferred: 1, failed: 1, partial: 1, ok: 2});
});
