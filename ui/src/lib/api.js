// The API layer every authenticated screen shares: Amplify configuration, the
// deployed endpoint bases, and one fetch wrapper that owns the error contract.
//
// This lives outside App.jsx so a route that is not the works screen (the
// collections and users sections) can call the API without importing the whole
// works UI along with it.
import {Amplify} from "aws-amplify";
import {fetchAuthSession} from "aws-amplify/auth";

export const MANIFEST_API_BASE = (process.env.NEXT_PUBLIC_MANIFEST_API_URL || "").replace(/\/$/, "");
// NEXT_PUBLIC_MANIFEST_API_URL already ends in /manifests, so the collections
// vocabulary is a sibling endpoint rather than a child of it. The fallback
// derives one so the feature still works against a stack deployed before the
// variable existed.
export const COLLECTION_API_BASE = (
  process.env.NEXT_PUBLIC_COLLECTION_API_URL ||
  (/\/manifests$/.test(MANIFEST_API_BASE) ? MANIFEST_API_BASE.replace(/\/manifests$/, "/collections") : "")
).replace(/\/$/, "");
// /manifests, /collections and /users are siblings, so /users is derived the
// same way the collections base is.
export const USER_API_BASE = /\/manifests$/.test(MANIFEST_API_BASE)
  ? MANIFEST_API_BASE.replace(/\/manifests$/, "/users")
  : "";
export const STORAGE_BUCKET = process.env.NEXT_PUBLIC_STORAGE_BUCKET || "";
export const STORAGE_REGION = process.env.NEXT_PUBLIC_STORAGE_REGION || "";
export const STORAGE_IDENTITY_POOL_ID = process.env.NEXT_PUBLIC_STORAGE_IDENTITY_POOL_ID || "";
export const COGNITO_USER_POOL_ID = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "";
export const COGNITO_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || "";

// Module-scope side effect, as before: importing this module is what configures
// Amplify, so every consumer of apiFetch is configured by construction.
if (STORAGE_BUCKET && STORAGE_REGION) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: COGNITO_USER_POOL_ID,
        userPoolClientId: COGNITO_CLIENT_ID,
        identityPoolId: STORAGE_IDENTITY_POOL_ID,
      },
    },
    Storage: {
      S3: {
        bucket: STORAGE_BUCKET,
        region: STORAGE_REGION,
      },
    },
  });
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
