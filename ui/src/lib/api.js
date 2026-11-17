// The API layer every authenticated screen shares: Amplify configuration, the
// deployed endpoint bases, and one fetch wrapper that owns the error contract.
//
// This lives outside App.jsx so a route that is not the works screen (the
// collections and users sections) can call the API without importing the whole
// works UI along with it.
import {Amplify} from "aws-amplify";
import {fetchAuthSession} from "aws-amplify/auth";
import {loadConfig} from "./config";

// The endpoint bases come from /config.json, which is only known at run time.
// They are `let` exports, set once by initializeApi() before AuthGate renders
// anything: an ES module export is a live binding, so every importer reads the
// assigned value as long as it reads it when it runs, not at its own module
// scope.
//
// /manifests, /collections and /users are siblings under the API's root.
export let MANIFEST_API_BASE = "";
export let COLLECTION_API_BASE = "";
export let USER_API_BASE = "";

let initializing = null;

// Loads /config.json, sets the bases above and configures Amplify. AuthGate
// awaits it, so it is the first thing every route does. Safe to call again:
// after the first success it resolves at once with the same config.
export function initializeApi() {
  if (!initializing) {
    initializing = loadConfig().then((config) => {
      MANIFEST_API_BASE = config.apiUrl ? `${config.apiUrl}/manifests` : "";
      COLLECTION_API_BASE = config.apiUrl ? `${config.apiUrl}/collections` : "";
      USER_API_BASE = config.apiUrl ? `${config.apiUrl}/users` : "";
      Amplify.configure({
        Auth: {
          Cognito: {
            userPoolId: config.userPoolId,
            userPoolClientId: config.userPoolClientId,
            identityPoolId: config.identityPoolId,
          },
        },
        Storage: {
          S3: {
            bucket: config.iiifBucket,
            region: config.region,
          },
        },
      });
      return config;
    });
    initializing.catch(() => {
      initializing = null;
    });
  }
  return initializing;
}

export async function authHeaders() {
  try {
    const { tokens } = await fetchAuthSession();
    return tokens?.idToken ? { Authorization: tokens.idToken.toString() } : {};
  } catch {
    return {};
  }
}

// Every call against our API repeats the same four steps: attach the Cognito
// token, send JSON, tolerate a non-JSON body, and throw the API's own error
// message. Doing it once keeps the error contract identical everywhere.
export async function apiFetch(url, {method = "GET", body, errorMessage = "Request failed"} = {}) {
  if (!url) {
    throw new Error("Work API unavailable");
  }
  const headers = await authHeaders();
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || errorMessage);
  }
  return data;
}

// The collection's works, filtered and paged by the server, which reads them
// from the collection's own documents rather than a search index — so a save
// is on the list the moment it returns.
export function collectionWorksUrl(slug, {q = "", from = 0, size = 50} = {}) {
  if (!COLLECTION_API_BASE) return null;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (from) params.set("from", String(from));
  params.set("size", String(size));
  return `${COLLECTION_API_BASE}/${encodeURIComponent(slug)}/works?${params}`;
}

// Where a collection's works are put in order: PUT {workId, afterWorkId}.
export function collectionOrderUrl(slug) {
  if (!COLLECTION_API_BASE) return null;
  return `${COLLECTION_API_BASE}/${encodeURIComponent(slug)}/order`;
}

// The collection's LIVE search index, queried through the API (which signs the
// request as the stack's own role). Backs the unlinked /collection/[slug]/search.
export function collectionSearchUrl(slug, {q = ""} = {}) {
  if (!COLLECTION_API_BASE) return null;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const query = params.toString();
  return `${COLLECTION_API_BASE}/${encodeURIComponent(slug)}/search${query ? `?${query}` : ""}`;
}

// Join the manifests base with a suffix. Both the collection works list and the
// work page build URLs this way, so it lives here rather than being redefined
// in each.
export function manifestApiUrl(path = "") {
  if (!MANIFEST_API_BASE) return null;
  const suffix = path ? `/${path.replace(/^\/+/, "")}` : "";
  return `${MANIFEST_API_BASE}${suffix}`;
}
