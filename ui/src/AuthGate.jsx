"use client";

import {useCallback, useEffect, useMemo, useState} from "react";
import {fetchAuthSession, getCurrentUser, signOut as amplifySignOut} from "aws-amplify/auth";
import {Flex, Spinner} from "@radix-ui/themes";
// For its side effect: importing api.js is what configures Amplify, and this is
// the first thing on every route to call it. Relying on a page to import it
// first would leave any route without one (not-found, a redirect) unconfigured.
import "./lib/api";
import SignIn from "./components/SignIn";
import {SessionContext, sessionFromGroups} from "./lib/session";

// Replaces Amplify's <Authenticator>: holds just enough session state to decide
// between the sign-in screen and the app. Tokens stay in Amplify's own storage —
// nothing about the credentials is kept here.
export default function AuthGate({children}) {
  const [status, setStatus] = useState("checking"); // checking | signedOut | signedIn
  const [session, setSession] = useState({username: "", role: null, collections: []});

  const refresh = useCallback(async () => {
    try {
      const current = await getCurrentUser();
      // The pool uses UsernameAttributes: [email], so Cognito's own `username`
      // is an opaque UUID. The email claim on the ID token is the value the
      // user actually signs in with, and unlike signInDetails it survives a
      // reload on a cached session.
      const {tokens} = await fetchAuthSession();
      const claims = tokens?.idToken?.payload || {};
      setSession({
        username:
          claims.email || current.signInDetails?.loginId || current.username || "",
        // Role and collection grants are Cognito Groups, so they arrive in the
        // token itself. They change only when the token is reissued — a grant
        // made now is invisible here until the user signs in again or the token
        // refreshes (an hour by default).
        ...sessionFromGroups(claims["cognito:groups"]),
      });
      setStatus("signedIn");
    } catch {
      // No cached session — expected on a first visit or after sign-out.
      setStatus("signedOut");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await amplifySignOut();
    } finally {
      setSession({username: "", role: null, collections: []});
      setStatus("signedOut");
    }
  }, []);

  // signOut travels with the session rather than as a prop: a layout's
  // children are elements, not a function it can hand arguments to.
  const value = useMemo(() => ({...session, signOut}), [session, signOut]);

  if (status === "checking") {
    return (
      <Flex align="center" justify="center" style={{minHeight: "100vh"}}>
        <Spinner size="3" />
      </Flex>
    );
  }

  if (status === "signedOut") {
    return <SignIn onSignedIn={refresh} />;
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
