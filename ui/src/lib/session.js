import {createContext, useContext} from "react";

// Who is signed in, and what they may do. Populated by AuthGate from the ID
// token and read anywhere in the app without prop-drilling.
//
// This is for SHAPING THE UI ONLY — hiding a section, requiring a field. The
// API re-derives all of it from the same token and is the only thing that
// actually enforces anything (app/shared/access.js). A stale or spoofed value
// here changes what the screen offers, never what the server permits.
export const SessionContext = createContext({
  username: "",
  role: null,
  collections: [],
  signOut: null,
});

export function useSession() {
  return useContext(SessionContext);
}

export const ROLE_ADMIN = "admin";
export const ROLE_EDITOR = "editor";
const COLLECTION_GROUP_PREFIX = "collection:";

// Mirrors principalFromClaims in app/shared/access.js. Amplify hands back a real
// array here (it parses the JWT), so this needs none of the string handling the
// server's copy does for API Gateway's serialized claim.
export function sessionFromGroups(groups) {
  const list = Array.isArray(groups) ? groups : [];
  return {
    role: list.includes(ROLE_ADMIN) ? ROLE_ADMIN : list.includes(ROLE_EDITOR) ? ROLE_EDITOR : null,
    collections: list
      .filter((group) => typeof group === "string" && group.startsWith(COLLECTION_GROUP_PREFIX))
      .map((group) => group.slice(COLLECTION_GROUP_PREFIX.length))
      .filter(Boolean)
      .sort(),
  };
}
