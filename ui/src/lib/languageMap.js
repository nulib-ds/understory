// IIIF language maps (Presentation 3.0 §4.4): {"en": ["a"], "fr": ["b"], "none": ["c"]}.
// Keys are BCP 47 codes, or `none` for text with no known language; every value
// is an array of strings. Applies to `label` and `summary`, and to the `label`
// and `value` of each `metadata` and `requiredStatement` entry.
//
// Two rules shape everything here:
//
// 1. READING follows the spec's algorithm, never "the first key": what a work
//    shows is decided by the viewer's language, then `none`, then any language.
// 2. WRITING touches one language key and carries every other key through
//    untouched. A manifest that arrives with `en` and `fr` must still have both
//    after a curator edits one of them, and a manifest that only has `none` must
//    still read exactly as it did.
//
// Imported manifests routinely lack `summary` and `behavior` entirely, so every
// read tolerates undefined.
//
// A lib module rather than a co-export from a component file: the Vite react-refresh
// rule (ui/eslint.config.js:13) warns on exported functions alongside components.

export const NONE = "none";

function entriesOf(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map).filter(([, values]) => Array.isArray(values));
}

const lower = (code) => String(code).toLowerCase();
const primary = (code) => lower(code).split("-")[0];

// Which of a map's language keys best fits one preferred code: an exact match
// first (BCP 47 is case-insensitive), then the same primary language, so a
// preference for `fr-CA` finds `fr` and one for `fr` finds `fr-CA`.
function bestMatch(codes, preference) {
  const wanted = lower(preference);
  return (
    codes.find((code) => lower(code) === wanted) ||
    codes.find((code) => primary(code) === primary(wanted)) ||
    null
  );
}

// The values the spec says to show, and the key they live under.
//   - all `none`: show them;
//   - some language fits the preferences: show that language's values;
//   - none fits, but there are `none` values: show those;
//   - none fits and every value has a language: pick one — the first.
// `key` is where an edit to what is shown belongs. It is null only for a map
// with nothing in it, which has nowhere to write yet.
export function resolveLanguageMap(map, preferences = []) {
  const entries = entriesOf(map);
  if (entries.length === 0) return {key: null, values: []};

  const languages = entries.map(([code]) => code).filter((code) => code !== NONE);
  let key = null;
  if (languages.length > 0) {
    for (const preference of preferences) {
      key = bestMatch(languages, preference);
      if (key) break;
    }
    if (!key) key = entries.some(([code]) => code === NONE) ? NONE : languages[0];
  } else {
    key = NONE;
  }
  return {key, values: map[key]};
}

// A map with `values` stored under `key` (default `none`) and every other key
// carried through, in its place. A language is never deleted from a field here:
// emptied, it is written as `[]`, so the working manifest keeps the gap for a
// curator to see and fill, and publishing takes it out (pruneEmptyLanguageValues,
// app/shared/publish.js), so no published document carries one.
export function writeLanguageValues(map, key, values) {
  const target = key || NONE;
  const next = {};
  for (const [code, existing] of entriesOf(map)) {
    next[code] = code === target ? values : existing;
  }
  if (!(target in next)) next[target] = values;
  return next;
}

// Every value in a map, each with the language key it is stored under, for an
// editor that has to show what the manifest holds rather than what a viewer
// would pick. The language the spec would show comes first, then the rest in
// the map's own order; values keep their order within a language.
export function languageEntries(map, preferences = []) {
  const entries = entriesOf(map);
  const {key: shown} = resolveLanguageMap(map, preferences);
  const ordered = [
    ...entries.filter(([code]) => code === shown),
    ...entries.filter(([code]) => code !== shown),
  ];
  return ordered.flatMap(([key, values]) =>
    values.map((value, index) => ({key, index, value})),
  );
}

// `map` with one value replaced, or removed when `next` is null; a language whose
// last value is removed stays, as `[]`. Every other value, in this language and
// in every other, is carried through.
export function setLanguageValue(map, key, index, next) {
  const values = entriesOf(map).find(([code]) => code === key)?.[1] || [];
  const updated =
    next === null
      ? values.filter((_, i) => i !== index)
      : index < values.length
        ? values.map((value, i) => (i === index ? next : value))
        : [...values, next];
  return writeLanguageValues(map, key, updated);
}

// The `lang` attribute for text shown from `key`: nothing for text with no
// language, which is how HTML says "unknown".
export function langAttribute(key) {
  return key && key !== NONE ? key : undefined;
}

// Every language code a work uses in what the app displays, in the order first
// met and without `none`. `canvases: false` leaves out the canvas labels, for a
// view of the work's own descriptive fields.
export function manifestLanguages(manifest, {canvases = true} = {}) {
  const found = new Set();
  const collect = (map) => {
    for (const [code] of entriesOf(map)) {
      if (code !== NONE) found.add(code);
    }
  };
  collect(manifest?.label);
  collect(manifest?.summary);
  for (const entry of Array.isArray(manifest?.metadata) ? manifest.metadata : []) {
    collect(entry?.label);
    collect(entry?.value);
  }
  collect(manifest?.requiredStatement?.label);
  collect(manifest?.requiredStatement?.value);
  if (canvases) {
    for (const canvas of Array.isArray(manifest?.items) ? manifest.items : []) {
      collect(canvas?.label);
    }
  }
  return [...found];
}

// Whether any of a work's text — its descriptive fields or its canvas labels —
// is stored with no language.
export function manifestHasNone(manifest) {
  const has = (map) => entriesOf(map).some(([code]) => code === NONE);
  return (
    (Array.isArray(manifest?.items) ? manifest.items : []).some((canvas) => has(canvas?.label)) ||
    has(manifest?.label) ||
    has(manifest?.summary) ||
    (Array.isArray(manifest?.metadata) ? manifest.metadata : []).some(
      (entry) => has(entry?.label) || has(entry?.value),
    ) ||
    has(manifest?.requiredStatement?.label) ||
    has(manifest?.requiredStatement?.value)
  );
}

// The viewer's own languages, in order of preference. [] outside a browser.
export function browserLanguages() {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? [...navigator.languages] : [navigator.language].filter(Boolean);
}

// A language's name in that language itself, from the browser's Intl data: "fr"
// is "Français", "ja" is "日本語", "pt-BR" is "Português (Brasil)". This is how a
// language names itself to the people who read it, and so how the app labels
// one. Capitalized in that language's own rules, since a name used as a label
// starts a line. `none` is "None", the spec's own word for text with no
// language. Falls back to the code for anything the browser does not know.
export function languageAutonym(code) {
  if (!code) return "";
  if (code === NONE) return "None";
  try {
    const name = new Intl.DisplayNames([code], {type: "language"}).of(code);
    if (!name || name === code) return code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}

// A code in words, in the viewer's own language: "fr" reads "French". Falls back
// to the code itself for anything the browser does not know.
export function languageName(code) {
  try {
    const name = new Intl.DisplayNames(browserLanguages().length ? browserLanguages() : ["en"], {
      type: "language",
    }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}
