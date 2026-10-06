// Per-work progress of a collection import, as markers in S3.
//
// A batch of ten works writes ONE result object, at its very end, so on its own
// the run can only say "batch 3 is done". The page wants every work's state, the
// way a work's own page shows each canvas, so each work also leaves a marker as
// it goes:
//
//   internal/collection-import/{slug}/{runId}/progress/{index}.{state}
//
// `index` is the work's position in plan.json, so a state string lines up with
// the plan one character per work. The state is in the KEY, so reading progress
// is one ListObjectsV2 (a thousand keys a page) rather than a GET per work —
// the same trick the batch-result count already relies on.
//
// SDK-free, so the rules are unit-tested; the S3 calls are in the two lambdas.

// state -> the character it takes in a state string, in order of how far along
// it is. A later rank wins when a work has more than one marker (it was marked
// "importing", then finished), and a re-run of a batch can only move forward.
const STATES = [
  {state: "queued", char: "q", rank: 0},
  {state: "importing", char: "i", rank: 1},
  {state: "deferred", char: "d", rank: 2},
  {state: "failed", char: "f", rank: 3},
  {state: "partial", char: "w", rank: 4},
  {state: "ok", char: "o", rank: 5},
];

const BY_STATE = new Map(STATES.map((entry) => [entry.state, entry]));
const BY_CHAR = new Map(STATES.map((entry) => [entry.char, entry]));

// What a batch result's `status` maps to. "ok" and "partial" are results;
// "deferred" and "failed" are too.
function progressKey(prefix, index, state) {
  if (!BY_STATE.has(state) || state === "queued") throw new Error(`Unknown progress state: ${state}`);
  return `${prefix}progress/${index}.${state}`;
}

// A marker key -> {index, state}, or null for anything that is not one.
function parseProgressKey(key) {
  const match = /\/progress\/(\d+)\.([a-z]+)$/.exec(String(key || ""));
  if (!match || !BY_STATE.has(match[2]) || match[2] === "queued") return null;
  return {index: Number(match[1]), state: match[2]};
}

// One character per planned work: the furthest state any of its markers reached,
// "q" (queued) where there is none. Markers beyond `total` are ignored.
function progressStates(total, keys) {
  const ranks = new Array(Math.max(0, total || 0)).fill(0);
  const chars = new Array(ranks.length).fill("q");
  for (const key of keys || []) {
    const parsed = parseProgressKey(key);
    if (!parsed || parsed.index >= ranks.length) continue;
    const entry = BY_STATE.get(parsed.state);
    if (entry.rank > ranks[parsed.index]) {
      ranks[parsed.index] = entry.rank;
      chars[parsed.index] = entry.char;
    }
  }
  return chars.join("");
}

// A state string -> how many works are in each state.
function countStates(states) {
  const counts = Object.fromEntries(STATES.map((entry) => [entry.state, 0]));
  for (const char of String(states || "")) {
    const entry = BY_CHAR.get(char);
    if (entry) counts[entry.state] += 1;
  }
  return counts;
}

module.exports = {STATES, progressKey, parseProgressKey, progressStates, countStates};
