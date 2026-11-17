// User directory and permission assignment, backed entirely by Cognito Groups.
//
// There is no separate permissions store: a role IS a group, and a collection
// grant IS a group named `collection:<slug>`. That is what lets the API
// authorize straight from the ID token with no lookup — see shared/access.js.
//
// Every route here is admin-only. That check is the one thing in this file that
// must never be relaxed: without it any signed-in user could add themselves to
// the admin group.

const {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminRemoveUserFromGroupCommand,
  CreateGroupCommand,
  ListGroupsCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const {
  ROLE_ADMIN,
  ROLES,
  collectionGroupName,
  collectionSlugFromGroup,
  canManageUsers,
  canAssignRoles,
  normalizeRoles,
} = require("../../../shared/access");
const {sanitizeCollectionSlug, CollectionNameError} = require("../../../shared/collection");
const {jsonResponse, parseBody} = require("./http");

const cognito = new CognitoIdentityProviderClient({});
const userPoolId = process.env.COGNITO_USER_POOL_ID;

const PAGE_LIMIT = 60;
// A directory this size is a management screen, not a data feed. The cap stops
// one request fanning out into an unbounded number of Cognito calls; past it the
// page says so rather than silently truncating.
const MAX_USERS = 500;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function listAllUsers() {
  const users = [];
  let paginationToken;
  do {
    const page = await cognito.send(
      new ListUsersCommand({UserPoolId: userPoolId, Limit: PAGE_LIMIT, PaginationToken: paginationToken}),
    );
    users.push(...(page.Users || []));
    paginationToken = page.PaginationToken;
  } while (paginationToken && users.length < MAX_USERS);
  return users;
}

async function listAllGroups() {
  const groups = [];
  let nextToken;
  do {
    const page = await cognito.send(
      new ListGroupsCommand({UserPoolId: userPoolId, Limit: PAGE_LIMIT, NextToken: nextToken}),
    );
    groups.push(...(page.Groups || []));
    nextToken = page.NextToken;
  } while (nextToken);
  return groups;
}

// Membership is read group-by-group rather than user-by-user: the number of
// groups is bounded by the collection count (small), while the number of users
// is not. One call per group beats one per user as the pool grows.
async function membershipByUsername() {
  const groups = await listAllGroups();
  const membership = new Map();
  await Promise.all(
    groups.map(async (group) => {
      let nextToken;
      do {
        const page = await cognito.send(
          new ListUsersInGroupCommand({
            UserPoolId: userPoolId,
            GroupName: group.GroupName,
            Limit: PAGE_LIMIT,
            NextToken: nextToken,
          }),
        );
        for (const user of page.Users || []) {
          if (!membership.has(user.Username)) membership.set(user.Username, []);
          membership.get(user.Username).push(group.GroupName);
        }
        nextToken = page.NextToken;
      } while (nextToken);
    }),
  );
  return {membership, groups};
}

function attribute(user, name) {
  return user.Attributes?.find((entry) => entry.Name === name)?.Value || null;
}

function serializeUser(user, groups) {
  const list = groups || [];
  return {
    // Cognito's Username is an opaque UUID under UsernameAttributes: [email],
    // and it is what every Admin* API call keys on — so it is the id the UI
    // sends back, even though the email is what it displays.
    username: user.Username,
    email: attribute(user, "email"),
    emailVerified: attribute(user, "email_verified") === "true",
    status: user.UserStatus,
    enabled: user.Enabled !== false,
    createdAt: user.UserCreateDate ? new Date(user.UserCreateDate).toISOString() : null,
    // Roles are independent, not a ladder: someone can hold both. The "User"
    // baseline the management screen shows is not among them — it is what
    // holding none means.
    roles: normalizeRoles(list),
    collections: list.map(collectionSlugFromGroup).filter(Boolean).sort(),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function validateDesired(body) {
  if (body.roles !== undefined && !Array.isArray(body.roles)) {
    throw new UserRequestError("roles must be an array");
  }
  for (const role of body.roles || []) {
    if (!ROLES.includes(role)) {
      throw new UserRequestError(`Not a role: ${String(role)} — expected any of ${ROLES.join(", ")}`);
    }
  }
  const roles = normalizeRoles(body.roles);
  if (body.collections !== undefined && !Array.isArray(body.collections)) {
    throw new UserRequestError("collections must be an array of slugs");
  }
  // sanitizeCollectionSlug also rejects the reserved root slug — a grant on the
  // collection of collections would mean nothing.
  const collections = [];
  for (const slug of new Set(body.collections || [])) {
    try {
      collections.push(sanitizeCollectionSlug(slug));
    } catch (error) {
      if (error instanceof CollectionNameError) {
        throw new UserRequestError(`Not a valid collection: ${String(slug)} — ${error.message}`);
      }
      throw error;
    }
  }
  return {roles, collections};
}

class UserRequestError extends Error {}

// Deliberately loose: Cognito is the real check, and it says why it refused.
// This only catches what is plainly not an address before a request is spent.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateInvite(body) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_SHAPE.test(email)) {
    throw new UserRequestError("email must be an email address");
  }
  return {email};
}

// Creates the user and has Cognito email them a temporary password, which the
// sign-in screen then asks them to replace (NEW_PASSWORD_STEP in SignIn.jsx).
// The pool is admin-create-only, so this is the only way into it short of the
// AWS console or CLI. A new user holds no role and no grant: the admin assigns
// those on the same screen, exactly as for anyone else.
async function inviteUser(email) {
  const result = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        {Name: "email", Value: email},
        {Name: "email_verified", Value: "true"},
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    }),
  );
  return result.User;
}

// A grant group is created on demand. Collections are user-created and dynamic,
// so they cannot be declared in the template the way the two role groups are.
async function ensureGroup(groupName, description) {
  try {
    await cognito.send(
      new CreateGroupCommand({UserPoolId: userPoolId, GroupName: groupName, Description: description}),
    );
  } catch (error) {
    if (error?.name !== "GroupExistsException") throw error;
  }
}

async function applyMembership(username, current, desired) {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  const toAdd = desired.filter((group) => !currentSet.has(group));
  const toRemove = current.filter((group) => !desiredSet.has(group));

  // Adds before removes: if the caller is re-granting themselves, a failure
  // partway through leaves them with more access than they started with rather
  // than locked out.
  for (const groupName of toAdd) {
    await ensureGroup(groupName, groupName.startsWith("collection:") ? "Collection grant" : "Role");
    await cognito.send(
      new AdminAddUserToGroupCommand({UserPoolId: userPoolId, Username: username, GroupName: groupName}),
    );
  }
  for (const groupName of toRemove) {
    await cognito.send(
      new AdminRemoveUserFromGroupCommand({UserPoolId: userPoolId, Username: username, GroupName: groupName}),
    );
  }
  return {added: toAdd, removed: toRemove};
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handleUsersRoute({method, segments, event, principal}) {
  if (!userPoolId) {
    return jsonResponse(500, {error: "COGNITO_USER_POOL_ID is not configured"});
  }
  if (!canManageUsers(principal)) {
    return jsonResponse(403, {error: "Only an administrator can manage users"});
  }

  if (segments.length === 1 && method === "GET") {
    try {
      const [users, {membership}] = await Promise.all([listAllUsers(), membershipByUsername()]);
      return jsonResponse(200, {
        users: users
          .map((user) => serializeUser(user, membership.get(user.Username)))
          .sort((a, b) => (a.email || "").localeCompare(b.email || "")),
        truncated: users.length >= MAX_USERS,
      });
    } catch (error) {
      console.error("List users failed", error);
      return jsonResponse(500, {error: "Unable to list users"});
    }
  }

  if (segments.length === 1 && method === "POST") {
    try {
      const {email} = validateInvite(parseBody(event));
      const user = await inviteUser(email);
      return jsonResponse(201, {user: serializeUser(user, [])});
    } catch (error) {
      if (error instanceof UserRequestError || error.message === "Invalid JSON payload") {
        return jsonResponse(400, {error: error.message});
      }
      if (error?.name === "UsernameExistsException") {
        return jsonResponse(409, {error: "A user with that email already exists"});
      }
      if (error?.name === "InvalidParameterException") {
        return jsonResponse(400, {error: error.message});
      }
      console.error("Invite user failed", error);
      return jsonResponse(500, {error: "Unable to invite user"});
    }
  }

  if (segments.length === 2 && method === "PUT") {
    const username = decodeURIComponent(segments[1]);
    try {
      const {roles, collections} = validateDesired(parseBody(event));

      // An admin may not drop their own admin role. The UI disables that
      // checkbox, but this is the check that actually holds.
      if (!canAssignRoles(principal, username, roles)) {
        return jsonResponse(403, {
          error: "You cannot remove your own Admin role. Ask another administrator.",
        });
      }

      const {membership} = await membershipByUsername();
      const current = membership.get(username) || [];

      // Backstop. Self-demotion is already refused above, and demoting someone
      // else always leaves the caller an admin, so this cannot normally fire —
      // it catches the case where the admin count was reduced outside the app
      // (an account deleted in the Cognito console, say).
      if (current.includes(ROLE_ADMIN) && !roles.includes(ROLE_ADMIN)) {
        const admins = await cognito.send(
          new ListUsersInGroupCommand({UserPoolId: userPoolId, GroupName: ROLE_ADMIN, Limit: PAGE_LIMIT}),
        );
        if ((admins.Users || []).length <= 1) {
          return jsonResponse(409, {
            error: "This is the only administrator. Promote someone else before changing this role.",
          });
        }
      }

      const desired = [...roles, ...collections.map(collectionGroupName)];
      // Groups this app does not own are left exactly as they are.
      const managed = new Set([...ROLES, ...current.filter((group) => collectionSlugFromGroup(group))]);
      const currentManaged = current.filter((group) => managed.has(group));
      const changes = await applyMembership(username, currentManaged, desired);

      // Only the fields this route actually changed. Fabricating a whole user
      // record from an empty attribute list would hand the UI a row claiming
      // the email and status are unset.
      const {membership: after} = await membershipByUsername();
      const groups = after.get(username) || [];
      return jsonResponse(200, {
        username,
        roles: normalizeRoles(groups),
        collections: groups.map(collectionSlugFromGroup).filter(Boolean).sort(),
        ...changes,
      });
    } catch (error) {
      if (error instanceof UserRequestError || error.message === "Invalid JSON payload") {
        return jsonResponse(400, {error: error.message});
      }
      if (error?.name === "UserNotFoundException") {
        return jsonResponse(404, {error: "User not found"});
      }
      console.error("Update user failed", error);
      return jsonResponse(500, {error: "Unable to update user"});
    }
  }

  return jsonResponse(405, {error: "Method not allowed"});
}

module.exports = {handleUsersRoute, serializeUser};
