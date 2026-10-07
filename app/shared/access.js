// Authorization model.
//
// Roles and per-collection grants are both Cognito Groups, so they arrive inside
// the ID token as the `cognito:groups` claim and the API authorizes with no
// extra lookup. Two role groups exist:
//
//   admin   — everything, including managing users
//   editor  — full control of works inside the collections granted to them
//
// A grant is a group named `collection:<slug>`. An editor holding
// `collection:eis` may edit, create, delete and re-file works in that
// collection, and nothing else.
//
// Reads are scoped the same way writes are: you see the collections you hold
// and the works inside them. Someone with no role and no grant sees nothing.
//
// A grant without the editor role is meaningful and read-only — it is how you
// give someone sight of a collection without letting them change it.
//
// IMPORTANT: this bounds what the DASHBOARD enumerates, not what exists. The
// IIIF bucket is world-readable by design (Clover fetches manifests
// unauthenticated), and the root collection is a public index of every
// collection and its members. Scoping these endpoints stops a signed-in user
// discovering the corpus through the app; it does not make any individual
// manifest secret.
//
// Pure — no AWS SDK, no I/O. Everything here is a function of the claims and the
// resource, so it is testable directly and cannot drift from what the API does.

const ROLE_ADMIN = "admin";
const ROLE_EDITOR = "editor";
const ROLES = [ROLE_ADMIN, ROLE_EDITOR];

// Colon is valid in a Cognito group name (the GroupName pattern allows Unicode
// punctuation) and cannot occur in a collection slug, so it separates the
// namespace from the slug unambiguously — unlike a hyphen, which slugs contain.
const COLLECTION_GROUP_PREFIX = "collection:";

function collectionGroupName(slug) {
  return `${COLLECTION_GROUP_PREFIX}${slug}`;
}

function collectionSlugFromGroup(name) {
  if (typeof name !== "string" || !name.startsWith(COLLECTION_GROUP_PREFIX)) return null;
  const slug = name.slice(COLLECTION_GROUP_PREFIX.length);
  return slug || null;
}

// API Gateway's HTTP API JWT authorizer does not hand back a JSON array for a
// multi-valued claim: it arrives as the string "[admin collection:eis]". Accept
// that, a real array (direct Lambda invoke, unit tests), and a bare string.
function parseGroupClaim(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry);
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .filter(Boolean);
}

// The caller, reduced to what any decision here needs. `collections` is the set
// of slugs granted; for an admin it is empty and unused, since admin short-
// circuits every check.
function principalFromClaims(claims) {
  const groups = parseGroupClaim(claims?.["cognito:groups"]);
  const role = groups.includes(ROLE_ADMIN)
    ? ROLE_ADMIN
    : groups.includes(ROLE_EDITOR)
      ? ROLE_EDITOR
      : null;
  const collections = new Set();
  for (const group of groups) {
    const slug = collectionSlugFromGroup(group);
    if (slug) collections.add(slug);
  }
  return {
    sub: claims?.sub || null,
    email: claims?.email || null,
    // `role` is the EFFECTIVE role, admin winning, and is what every
    // authorization check below reads. `roles` is everything they actually
    // hold — the user-management screen assigns them independently, so someone
    // can be both.
    role,
    roles: normalizeRoles(groups),
    collections,
    groups,
  };
}

// The role groups in a list, deduped and in a fixed order, with anything that
// is not a real role dropped. The "User" checkbox the management screen always
// shows is a baseline, not a group: everyone who can sign in has it, and
// nothing is written for it.
function normalizeRoles(value) {
  const list = Array.isArray(value) ? value : [];
  return ROLES.filter((role) => list.includes(role));
}

// An admin may not drop their own admin role.
//
// Beyond being an obvious footgun, this is what makes the pool un-lockable:
// the only call that can reduce the admin count is one admin demoting another,
// which by definition leaves the caller behind. With self-demotion refused,
// no sequence of API calls can reach zero admins.
function canAssignRoles(principal, targetUsername, nextRoles) {
  if (!canManageUsers(principal)) return false;
  // Cognito's Username IS the sub in this pool (UsernameAttributes: [email]
  // makes the email an alias, so Username is the generated UUID). Verified
  // against the deployed pool rather than assumed.
  const isSelf = Boolean(principal?.sub) && principal.sub === targetUsername;
  return !(isSelf && !normalizeRoles(nextRoles).includes(ROLE_ADMIN));
}

function principalFromEvent(event) {
  return principalFromClaims(event?.requestContext?.authorizer?.jwt?.claims || {});
}

function isAdmin(principal) {
  return principal?.role === ROLE_ADMIN;
}

function isEditor(principal) {
  return principal?.role === ROLE_EDITOR;
}

function grants(principal) {
  return principal?.collections instanceof Set ? principal.collections : new Set();
}

// Only an admin may read or change the user directory. This is the one check
// that must never be relaxed: without it any signed-in user could add themselves
// to the admin group.
// What a caller may see. `null` means no restriction (admin); otherwise the
// exact set of collection slugs, which may be empty — and empty means nothing.
function visibleCollectionSlugs(principal) {
  if (isAdmin(principal)) return null;
  return [...grants(principal)].sort();
}

// A work is visible if it sits in the collection the caller holds. Every work
// has exactly one now; a work reporting none is damage, and refusing is the
// safe reading of it.
function canViewWork(principal, collectionSlugs) {
  if (isAdmin(principal)) return true;
  const held = grants(principal);
  if (!held.size) return false;
  return toSlugArray(collectionSlugs).some((slug) => held.has(slug));
}

function canViewCollection(principal, slug) {
  if (isAdmin(principal)) return true;
  return grants(principal).has(slug);
}

// Collections are created and deleted only by admins, and only on the
// Collections screen. Nothing else instantiates one — see the existence check
// in handleManifestCollectionsRoute, which stops a work's Linking tab from
// conjuring a collection as a side effect of being saved.
function canManageCollections(principal) {
  return isAdmin(principal);
}

function canManageUsers(principal) {
  return isAdmin(principal);
}

// Rebuilding the collection projection rewrites every collection document, so it
// stays with admins even though an editor can change membership.
function canReindex(principal) {
  return isAdmin(principal);
}

// Editing an existing work: an editor needs a grant on the collection it is in.
// Still written against a list so a manifest that somehow carries more than one
// managed partOf entry degrades to "any of them will do" rather than throwing.
function canEditWork(principal, currentSlugs) {
  if (isAdmin(principal)) return true;
  if (!isEditor(principal)) return false;
  const held = grants(principal);
  return toSlugArray(currentSlugs).some((slug) => held.has(slug));
}

// Creating a work: it must be filed into exactly one collection. A work no
// longer belongs to zero or several, so even an admin names one — there is no
// uncollected state left to land in. An editor must additionally hold the
// collection, or they would immediately lose access to what they just made.
function canCreateWork(principal, desiredSlugs) {
  const desired = toSlugArray(desiredSlugs);
  if (desired.length !== 1) return false;
  if (isAdmin(principal)) return true;
  if (!isEditor(principal)) return false;
  return grants(principal).has(desired[0]);
}

// Moving a work between collections. Both ends must be held: taking a work out
// of someone else's collection and dropping one into someone else's are the
// same kind of act, and an editor may do neither.
//
// Re-filing into the collection the work is already in is a no-op rather than a
// permission question, so it asks only for what an ordinary edit asks.
function canMoveWork(principal, fromSlug, toSlug) {
  if (!toSlug) return false;
  if (isAdmin(principal)) return true;
  if (!isEditor(principal)) return false;
  const held = grants(principal);
  if (fromSlug === toSlug) return held.has(toSlug);
  return held.has(toSlug) && (!fromSlug || held.has(fromSlug));
}

// Publishing one collection. Deliberately not admin-only the way canReindex is:
// that stayed with admins because rebuilding the projection rewrote every
// collection document, and this rewrites exactly one — the one the editor was
// granted.
function canPublish(principal, slug) {
  if (isAdmin(principal)) return true;
  if (!isEditor(principal)) return false;
  return Boolean(slug) && grants(principal).has(slug);
}

// Putting a collection's works in order. The same people as publish: an admin,
// or an editor holding the collection. It rewrites exactly that collection's
// leaf, and changes nothing a curator could not already change by editing.
function canOrderCollection(principal, slug) {
  return canPublish(principal, slug);
}

// The symmetric difference: what this save actually adds or removes. Untouched
// memberships are none of the check's business, so a work that already sits in a
// collection the editor cannot see is not a reason to refuse an unrelated edit.
function changedSlugs(currentSlugs, nextSlugs) {
  const current = new Set(toSlugArray(currentSlugs));
  const next = new Set(toSlugArray(nextSlugs));
  const changed = [];
  for (const slug of current) if (!next.has(slug)) changed.push(slug);
  for (const slug of next) if (!current.has(slug)) changed.push(slug);
  return changed.sort();
}

// Accepts the shapes the API already passes around: bare slugs, or the
// {slug, label} refs that manifests and the collections endpoint return.
function toSlugArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : entry?.slug))
    .filter((slug) => typeof slug === "string" && slug);
}

module.exports = {
  ROLE_ADMIN,
  canManageCollections,
  visibleCollectionSlugs,
  canViewWork,
  canViewCollection,
  normalizeRoles,
  canAssignRoles,
  ROLE_EDITOR,
  ROLES,
  COLLECTION_GROUP_PREFIX,
  collectionGroupName,
  collectionSlugFromGroup,
  parseGroupClaim,
  principalFromClaims,
  principalFromEvent,
  isAdmin,
  isEditor,
  canManageUsers,
  canReindex,
  canEditWork,
  canCreateWork,
  canMoveWork,
  canPublish,
  canOrderCollection,
  changedSlugs,
  toSlugArray,
};
