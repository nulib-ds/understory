import {createContext, useContext, useEffect, useMemo, useState} from "react";
import {NONE} from "./languageMap";
import {COLLECTION_API_BASE, apiFetch} from "./api";
import {useReportReady} from "./pageReady";

// The languages the work page is showing, most preferred first. A context
// because the title, the canvas list and the metadata panel all read language
// maps, and the choice is made once, above all of them. The default is no
// preference, which resolves a map by its own order: the same as showing the
// work to someone whose browser states none.
export const WorkLanguageContext = createContext([]);

export function useLanguagePreferences() {
  return useContext(WorkLanguageContext);
}

// The language lanes a page shows its text in, and which are turned on: one
// state for the whole page, so a choice made with the chips (LanguageChips,
// beside the section control) holds on every tab. The work page draws its
// fields and canvas labels in them; the collection page, its works' titles.
// Created once by the page (useLanguageLanesState) and read below it through
// LanguageLanesContext (useLanguageLanes).
//
// The lanes: the collection's languages in its order of preference, then any
// other language the page's text uses (`used`), then None. Only what the
// curator has toggled is held; every other lane follows its default, so a
// language set on the collection later still comes on. None is on by default
// only where the text has some with no language (`hasNone`).
//
// `inUse` is {used, hasNone}, computed by the page from what it shows, and
// memoized there.
export function useLanguageLanesState(collectionLanguages, inUse) {
  const [toggled, setToggled] = useState({});
  const used = inUse?.used;
  const hasNone = Boolean(inUse?.hasNone);
  const lanes = useMemo(() => {
    const own = (used || []).filter((code) => !collectionLanguages.includes(code));
    return [...collectionLanguages, ...own, NONE];
  }, [used, collectionLanguages]);
  const isOn = (code) => toggled[code] ?? (code === NONE ? hasNone : true);
  return {
    lanes,
    isOn,
    toggle: (code) => setToggled((prev) => ({...prev, [code]: !isOn(code)})),
    visible: lanes.filter(isOn),
    preferred: collectionLanguages[0] || null,
    collectionLanguages,
  };
}

const NO_LANES = {
  lanes: [NONE],
  isOn: () => true,
  toggle: () => {},
  visible: [NONE],
  preferred: null,
  collectionLanguages: [],
};

export const LanguageLanesContext = createContext(NO_LANES);

export function useLanguageLanes() {
  return useContext(LanguageLanesContext);
}

// The languages a work's collection is described in, most preferred first
// (GET /collections/{slug}/languages). Every work takes its collection's list as
// its own. Reports to the page's reveal gate, so the page appears once with the
// right language showing rather than switching after it is on screen.
// One empty list, so a render with no languages yet does not hand the memos
// below a new array every time.
const NO_LANGUAGES = [];

export function useCollectionLanguages(slug) {
  const [state, setState] = useState({slug: null, languages: []});
  useEffect(() => {
    if (!slug || !COLLECTION_API_BASE) return undefined;
    let cancelled = false;
    apiFetch(`${COLLECTION_API_BASE}/${encodeURIComponent(slug)}/languages`, {
      errorMessage: "Unable to load the collection's languages",
    })
      .then((data) => !cancelled && setState({slug, languages: data.languages || []}))
      // Without the list the work still reads, by the spec's own fallback.
      .catch(() => !cancelled && setState({slug, languages: []}));
    return () => {
      cancelled = true;
    };
  }, [slug]);
  useReportReady(!slug || !COLLECTION_API_BASE || state.slug === slug);
  return state.slug === slug ? state.languages : NO_LANGUAGES;
}
