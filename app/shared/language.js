// IIIF language maps — {"none": ["value", ...]} — and reading a single display
// string back out of one.
//
// Split out of manifest.js so modules that only need the value shapes don't have
// to load the AWS SDK along with them. Keep this file dependency-free.

function languageMap(value) {
  return {none: [String(value ?? "")]};
}

function extractLabel(labelValue) {
  if (typeof labelValue === "string") {
    return labelValue;
  }
  if (Array.isArray(labelValue)) {
    return labelValue.find((entry) => typeof entry === "string") || "";
  }
  if (labelValue && typeof labelValue === "object") {
    const candidates = labelValue.none || Object.values(labelValue)[0];
    if (Array.isArray(candidates)) {
      return candidates.find((entry) => typeof entry === "string") || "";
    }
  }
  return "";
}

// A label as a language map, whichever it arrives as: a map is kept, every
// language it has carried through (values that are not arrays of strings are
// dropped); a plain string becomes a map with no language, as languageMap makes
// it. So a collection member can record a work's title in every language it
// has, while builders that are handed a string keep working.
function asLanguageMap(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const map = {};
    for (const [code, values] of Object.entries(value)) {
      if (Array.isArray(values)) map[code] = values.filter((entry) => typeof entry === "string");
    }
    if (Object.keys(map).length) return map;
  }
  return languageMap(typeof value === "string" ? value : extractLabel(value));
}

// Every string in a language map, in all its languages, for matching a filter
// against a title whatever language the words are in.
function languageMapText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return Object.values(value)
    .flatMap((values) => (Array.isArray(values) ? values : []))
    .filter((entry) => typeof entry === "string")
    .join(" ");
}

module.exports = {
  languageMap,
  extractLabel,
  asLanguageMap,
  languageMapText,
};
