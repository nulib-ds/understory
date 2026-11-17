// What InstanceSetup (app/aws/lambdas/instance-setup/) writes into an
// instance's UI bucket, decided without touching AWS so it can be tested.
//
// The bucket holds three things, from three sources:
//
//   (everything else)  the admin UI's static export, from UiLayer
//   branding/…         the instance's branding folder, from BrandingLayer
//   config.json        the instance's settings, from the stack
//
// Every deploy rewrites all three and deletes whatever else is there, so the
// bucket is always exactly one release's UI, one branding folder and one
// config.

const BRANDING_PREFIX = "branding/";
const CONFIG_KEY = "config.json";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  // Next's static export writes each page's RSC payload as .txt, and its
  // client router accepts text/plain for them only in an export build.
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

// The admin distribution sends nosniff (SecurityHeadersPolicy), so a file
// served with the wrong type is refused rather than guessed at: a theme.css
// sent as octet-stream simply never applies.
function contentTypeFor(key) {
  const match = /(\.[A-Za-z0-9]+)$/.exec(key);
  return (match && CONTENT_TYPES[match[1].toLowerCase()]) || "application/octet-stream";
}

// _next/static/* is named by content hash, so it can be cached for ever.
// Everything else must be seen fresh after a deploy: the HTML that names the
// current hashes, the config and the branding. no-cache means "revalidate",
// which the edge answers cheaply with a 304.
function cacheControlFor(key) {
  return key.startsWith("_next/static/") ? "public, max-age=31536000, immutable" : "no-cache";
}

const hasHiddenSegment = (relativePath) => relativePath.split("/").some((part) => part.startsWith("."));

// UI files are published at their own path, except the two the instance owns.
// A local `next build` copies public/ into the export, and public/ is where
// `npm run config` puts a stack's config and branding; neither may stand in
// for this instance's.
function uiKey(relativePath) {
  if (hasHiddenSegment(relativePath)) return null;
  if (relativePath === CONFIG_KEY || relativePath.startsWith(BRANDING_PREFIX)) return null;
  return relativePath;
}

// Branding files are published under branding/. Left out: dotfiles (.DS_Store,
// a stray .git), a README at the folder's root (the instance template's
// explains the slots), and understory-ui/, which is UiLayer sharing /opt.
function brandingKey(relativePath) {
  if (hasHiddenSegment(relativePath)) return null;
  if (relativePath.startsWith("understory-ui/")) return null;
  if (/^readme(\.[a-z]+)?$/i.test(relativePath)) return null;
  return `${BRANDING_PREFIX}${relativePath}`;
}

// The document the UI reads (ui/src/lib/config.js). CloudFormation hands a
// custom resource every property as a string, which is what each of these is.
function buildConfigDocument(config, brandingKeys) {
  return {
    ...config,
    brandingFiles: brandingKeys.map((key) => key.slice(BRANDING_PREFIX.length)).sort(),
  };
}

// Everything in the bucket that this deploy did not write.
function staleKeys(existingKeys, writtenKeys) {
  const written = new Set(writtenKeys);
  return existingKeys.filter((key) => !written.has(key));
}

module.exports = {
  BRANDING_PREFIX,
  CONFIG_KEY,
  brandingKey,
  buildConfigDocument,
  cacheControlFor,
  contentTypeFor,
  staleKeys,
  uiKey,
};
