"use client";

import {useCallback, useEffect, useMemo, useState} from "react";
import {fetchAuthSession, getCurrentUser, signOut as amplifySignOut} from "aws-amplify/auth";
import {Callout, Flex, Spinner, Theme} from "@radix-ui/themes";
import {initializeApi} from "./lib/api";
import {BrandingContext, loadBranding, pageTitle} from "./lib/branding";
import SignIn from "./components/SignIn";
import {SessionContext, sessionFromGroups} from "./lib/session";

// Replaces Amplify's <Authenticator>: holds just enough session state to decide
// between the sign-in screen and the app. Tokens stay in Amplify's own storage —
// nothing about the credentials is kept here.
//
// It is also the first thing on every route, so it is what loads the instance's
// /config.json (which configures Amplify and the API bases) and its branding.
// Nothing beneath it renders until both are in.
export default function AuthGate({children}) {
  // checking | unconfigured | signedOut | signedIn
  const [status, setStatus] = useState("checking");
  const [session, setSession] = useState({username: "", role: null, collections: []});
  const [branding, setBranding] = useState(null);
  const [configError, setConfigError] = useState(null);

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
    let cancelled = false;
    (async () => {
      try {
        const config = await initializeApi();
        const loaded = await loadBranding(config);
        if (cancelled) return;
        setBranding(loaded);
      } catch (error) {
        if (cancelled) return;
        setConfigError(error);
        setStatus("unconfigured");
        return;
      }
      refresh();
    })();
    return () => {
      cancelled = true;
    };
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

  const title = <title>{pageTitle(branding)}</title>;

  if (status === "checking") {
    return (
      <Flex align="center" justify="center" style={{minHeight: "100vh"}}>
        {title}
        <Spinner size="3" />
      </Flex>
    );
  }

  if (status === "unconfigured") {
    return (
      <Flex align="center" justify="center" style={{minHeight: "100vh"}} p="4">
        {title}
        <Callout.Root color="red" style={{maxWidth: "40rem"}}>
          <Callout.Text>
            This Understory instance could not load its settings from /config.json ({configError?.message}). The
            deploy writes that file; locally, run npm run config with your stack&apos;s name.
          </Callout.Text>
        </Callout.Root>
      </Flex>
    );
  }

  // A nested Theme carries the instance's accent colour; the root Theme in
  // layout.jsx has the product default, which is all the spinner above needs.
  return (
    <BrandingContext.Provider value={branding}>
      <Theme accentColor={branding.accentColor}>
        {title}
        {status === "signedOut" ? (
          <SignIn onSignedIn={refresh} />
        ) : (
          <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
        )}
      </Theme>
    </BrandingContext.Provider>
  );
}
