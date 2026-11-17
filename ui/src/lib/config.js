// The instance's settings, read at run time from /config.json.
//
// One build of the UI serves every Understory instance, so nothing about a
// stack can be compiled in. InstanceSetup (app/aws/lambdas/instance-setup/)
// writes /config.json into the UI bucket on every deploy; locally,
// `npm run config <stack>` copies a deployed stack's file into public/.
//
// AuthGate waits for this before it renders anything, so every screen can read
// getConfig() synchronously.

let current = null;
let pending = null;

// Every key the UI reads, with the value it falls back to. A key missing from
// an older file reads as its default rather than as undefined.
const DEFAULTS = {
  version: "",
  region: "",
  apiUrl: "",
  documentsUrl: "",
  imageApiUrl: "",
  iiifBucket: "",
  sourceBucket: "",
  userPoolId: "",
  userPoolClientId: "",
  identityPoolId: "",
  institutionName: "",
  accentColor: "iris",
  // Paths under /branding/ that the deploy found in the instance's branding
  // folder, e.g. ["theme.css", "header.html", "assets/logo.svg"].
  brandingFiles: [],
};

const trimSlash = (value) => (typeof value === "string" ? value.replace(/\/+$/, "") : "");

function normalizeConfig(raw) {
  const config = {...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {})};
  for (const key of ["apiUrl", "documentsUrl", "imageApiUrl"]) {
    config[key] = trimSlash(config[key]);
  }
  config.brandingFiles = Array.isArray(config.brandingFiles) ? config.brandingFiles : [];
  return Object.freeze(config);
}

export function loadConfig() {
  if (!pending) {
    pending = fetch("/config.json", {cache: "no-store"})
      .then((response) => {
        if (!response.ok) throw new Error(`/config.json returned ${response.status}`);
        return response.json();
      })
      .then((raw) => {
        current = normalizeConfig(raw);
        return current;
      });
    // A failed load can be retried; a successful one is never repeated.
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

// The defaults until loadConfig() has resolved. Nothing under AuthGate runs
// before then.
export function getConfig() {
  return current || normalizeConfig(null);
}
