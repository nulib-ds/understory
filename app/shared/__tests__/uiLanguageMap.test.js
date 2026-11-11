// The UI's language-map helper (ui/src/lib/languageMap.js). It is ESM with no
// dependencies, so it loads here with a dynamic import and needs no UI test
// runner — the repo has none.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../../../ui/src/lib/languageMap.js")).href);

// The spec's own example (§4.4): English, French and unlanguaged text together.
const WHISTLER = {
  en: ["Whistler's Mother", "Arrangement in Grey and Black No. 1"],
  fr: ["Arrangement en gris et noir no 1", "La Mère de Whistler"],
  none: ["Whistler (1871)"],
};

test("a map of only `none` shows all of its values, whatever the preference", async () => {
  const {resolveLanguageMap} = await load();
  assert.deepEqual(resolveLanguageMap({none: ["a", "b"]}, ["fr"]), {key: "none", values: ["a", "b"]});
  assert.deepEqual(resolveLanguageMap({none: ["a"]}), {key: "none", values: ["a"]});
});

test("the preferred language wins over `none` and shows all of its values", async () => {
  const {resolveLanguageMap} = await load();
  assert.deepEqual(resolveLanguageMap(WHISTLER, ["fr"]), {key: "fr", values: WHISTLER.fr});
  assert.deepEqual(resolveLanguageMap(WHISTLER, ["de", "en"]), {key: "en", values: WHISTLER.en});
});

test("preferences match case-insensitively and by primary language", async () => {
  const {resolveLanguageMap} = await load();
  assert.equal(resolveLanguageMap({fr: ["x"], en: ["y"]}, ["fr-CA"]).key, "fr");
  assert.equal(resolveLanguageMap({"fr-CA": ["x"], en: ["y"]}, ["fr"]).key, "fr-CA");
  assert.equal(resolveLanguageMap({"AR-latn": ["x"], en: ["y"]}, ["ar-LATN"]).key, "AR-latn");
});

test("no match with `none` present shows the unlanguaged values", async () => {
  const {resolveLanguageMap} = await load();
  assert.deepEqual(resolveLanguageMap(WHISTLER, ["ja"]), {key: "none", values: WHISTLER.none});
});

test("no match and every value languaged picks the first language", async () => {
  const {resolveLanguageMap} = await load();
  assert.deepEqual(resolveLanguageMap({fr: ["x"], en: ["y"]}, ["ja"]), {key: "fr", values: ["x"]});
  assert.deepEqual(resolveLanguageMap({fr: ["x"], en: ["y"]}, []), {key: "fr", values: ["x"]});
});

test("an empty or missing map has no key and no values", async () => {
  const {resolveLanguageMap} = await load();
  for (const empty of [undefined, null, {}, [], "text"]) {
    assert.deepEqual(resolveLanguageMap(empty, ["en"]), {key: null, values: []});
  }
});

test("writing one language carries every other key through untouched", async () => {
  const {writeLanguageValues} = await load();
  const next = writeLanguageValues(WHISTLER, "fr", ["Nouveau"]);
  assert.deepEqual(next, {en: WHISTLER.en, fr: ["Nouveau"], none: WHISTLER.none});
  // The input is never mutated: React state is built from it.
  assert.deepEqual(WHISTLER.fr, ["Arrangement en gris et noir no 1", "La Mère de Whistler"]);
});

test("writing keeps the order of the other keys", async () => {
  const {writeLanguageValues} = await load();
  const next = writeLanguageValues({en: ["a"], fr: ["b"], de: ["c"]}, "fr", ["B"]);
  assert.deepEqual(Object.keys(next).sort(), ["de", "en", "fr"]);
  assert.deepEqual(next.fr, ["B"]);
});

test("writing to a map with nothing in it, or with no key, uses `none`", async () => {
  const {writeLanguageValues} = await load();
  assert.deepEqual(writeLanguageValues(undefined, null, ["a"]), {none: ["a"]});
  assert.deepEqual(writeLanguageValues({}, undefined, ["a"]), {none: ["a"]});
});

test("emptying a language keeps it, as [], in its place; nothing is deleted", async () => {
  const {writeLanguageValues} = await load();
  assert.deepEqual(writeLanguageValues({none: ["a"]}, "none", []), {none: []});
  const next = writeLanguageValues({en: ["a"], fr: ["b"], de: ["c"]}, "fr", []);
  assert.deepEqual(next, {en: ["a"], fr: [], de: ["c"]});
  assert.deepEqual(Object.keys(next), ["en", "fr", "de"], "the emptied key keeps its place");
});

test("an edit to what is shown round-trips: a `none`-only map stays `none`-only", async () => {
  const {resolveLanguageMap, writeLanguageValues} = await load();
  const original = {none: ["Old title"]};
  const {key} = resolveLanguageMap(original, ["fr"]);
  assert.deepEqual(writeLanguageValues(original, key, ["New title"]), {none: ["New title"]});
});

test("an edit to what is shown through the fallback lands on the key it came from", async () => {
  const {resolveLanguageMap, writeLanguageValues} = await load();
  // A French-only label, viewed by someone preferring English: they see French,
  // so editing it must change the French, not invent an English entry.
  const original = {fr: ["Titre"]};
  const {key, values} = resolveLanguageMap(original, ["en"]);
  assert.deepEqual(writeLanguageValues(original, key, [`${values[0]}!`]), {fr: ["Titre!"]});
});

test("malformed entries are ignored rather than thrown on", async () => {
  const {resolveLanguageMap} = await load();
  assert.deepEqual(resolveLanguageMap({en: "not an array", fr: ["ok"]}, ["en"]), {
    key: "fr",
    values: ["ok"],
  });
});

test("manifestLanguages gathers codes from every displayed property, without `none`", async () => {
  const {manifestLanguages} = await load();
  const manifest = {
    label: {en: ["T"], none: ["t"]},
    summary: {fr: ["S"]},
    metadata: [
      {label: {en: ["Date"]}, value: {none: ["2012"]}},
      {label: {de: ["Ort"]}, value: {de: ["Reggio"], en: ["Reggio"]}},
    ],
    requiredStatement: {label: {es: ["Atribución"]}, value: {es: ["x"]}},
    items: [{label: {ja: ["表"]}}, {label: {none: ["Front"]}}],
  };
  assert.deepEqual(manifestLanguages(manifest), ["en", "fr", "de", "es", "ja"]);
});

test("manifestLanguages tolerates a manifest with none of it", async () => {
  const {manifestLanguages} = await load();
  assert.deepEqual(manifestLanguages(undefined), []);
  assert.deepEqual(manifestLanguages({label: {none: ["T"]}}), []);
});

test("languageEntries lists every value with its key, the shown language first", async () => {
  const {languageEntries} = await load();
  assert.deepEqual(languageEntries(WHISTLER, ["fr"]), [
    {key: "fr", index: 0, value: WHISTLER.fr[0]},
    {key: "fr", index: 1, value: WHISTLER.fr[1]},
    {key: "en", index: 0, value: WHISTLER.en[0]},
    {key: "en", index: 1, value: WHISTLER.en[1]},
    {key: "none", index: 0, value: WHISTLER.none[0]},
  ]);
  assert.deepEqual(languageEntries({none: ["a"]}), [{key: "none", index: 0, value: "a"}]);
  assert.deepEqual(languageEntries(undefined), []);
});

test("setLanguageValue replaces, appends and removes one value and nothing else", async () => {
  const {setLanguageValue} = await load();
  const map = {en: ["a", "b"], fr: ["c"]};
  assert.deepEqual(setLanguageValue(map, "en", 1, "B"), {en: ["a", "B"], fr: ["c"]});
  assert.deepEqual(setLanguageValue(map, "fr", 1, "d"), {en: ["a", "b"], fr: ["c", "d"]});
  assert.deepEqual(setLanguageValue(map, "en", 0, null), {en: ["b"], fr: ["c"]});
  assert.deepEqual(setLanguageValue(map, "fr", 0, null), {en: ["a", "b"], fr: []});
  assert.deepEqual(setLanguageValue({none: ["x"]}, "none", 0, null), {none: []});
  assert.deepEqual(setLanguageValue(undefined, "none", 0, "x"), {none: ["x"]});
});

test("langAttribute says nothing for text with no language", async () => {
  const {langAttribute} = await load();
  assert.equal(langAttribute("none"), undefined);
  assert.equal(langAttribute(null), undefined);
  assert.equal(langAttribute("fr"), "fr");
});
