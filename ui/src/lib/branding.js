import {createContext, useContext} from "react";

// An instance's branding, from its own branding/ folder: the deploy copies the
// folder to /branding/ in the UI bucket and lists what it found in
// /config.json (brandingFiles). Every slot is optional; an instance with an
// empty folder gets the product's neutral look.
//
// The slots are part of the release contract (see RELEASING.md): removing or
// renaming one is a major version.
//
//   theme.css      loaded after the app's own CSS, so it can redefine any
//                  documented token (--accent-1..12, --gray-1..12, --brand-bar-*)
//   header.html    the left of the top bar, in place of the institution name
//   footer.html    a footer under every signed-in page
//   sign-in.html   text on the sign-in card
//   favicon.svg / favicon.png / favicon.ico
//
// Snippets are rendered by renderSnippetHtml (lib/iiifHtml.js), never as raw
// HTML.

export const RADIX_ACCENTS = new Set([
  "gray", "gold", "bronze", "brown", "yellow", "amber", "orange", "tomato", "red", "ruby",
  "crimson", "pink", "plum", "purple", "violet", "iris", "indigo", "blue", "cyan", "teal",
  "jade", "green", "grass", "lime", "mint", "sky",
]);

const SNIPPETS = {header: "header.html", footer: "footer.html", signIn: "sign-in.html"};
const FAVICONS = ["favicon.svg", "favicon.png", "favicon.ico"];

const EMPTY = Object.freeze({
  institutionName: "",
  accentColor: "iris",
  header: "",
  footer: "",
  signIn: "",
});

export const BrandingContext = createContext(EMPTY);

export function useBranding() {
  return useContext(BrandingContext);
}

export const pageTitle = (branding) =>
  branding?.institutionName ? `Understory · ${branding.institutionName}` : "Understory";

const brandingUrl = (path) => `/branding/${path.split("/").map(encodeURIComponent).join("/")}`;

// Resolves once the stylesheet has loaded (or failed), so the page never shows
// unbranded and then repaints.
function addStylesheet(href) {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => {
      console.warn(`Branding stylesheet ${href} did not load`);
      resolve();
    };
    // Appended last in <head>, so it follows every sheet the app ships.
    document.head.appendChild(link);
  });
}

function setFavicon(href) {
  for (const existing of document.querySelectorAll("link[rel~='icon']")) existing.remove();
  const link = document.createElement("link");
  link.rel = "icon";
  link.href = href;
  document.head.appendChild(link);
}

async function fetchSnippet(path) {
  try {
    const response = await fetch(brandingUrl(path), {cache: "no-cache"});
    return response.ok ? await response.text() : "";
  } catch {
    return "";
  }
}

// Everything at once, so the wait is the slowest file, not the sum. A file
// that fails to load is left out rather than holding the app.
export async function loadBranding(config) {
  const files = new Set(config.brandingFiles || []);
  const accentColor = RADIX_ACCENTS.has(config.accentColor) ? config.accentColor : "iris";

  const favicon = FAVICONS.find((name) => files.has(name));
  if (favicon) setFavicon(brandingUrl(favicon));

  const [snippets] = await Promise.all([
    Promise.all(
      Object.entries(SNIPPETS).map(async ([slot, path]) => [slot, files.has(path) ? await fetchSnippet(path) : ""]),
    ),
    files.has("theme.css") ? addStylesheet(brandingUrl("theme.css")) : null,
  ]);

  return Object.freeze({
    ...EMPTY,
    institutionName: config.institutionName || "",
    accentColor,
    ...Object.fromEntries(snippets),
  });
}
