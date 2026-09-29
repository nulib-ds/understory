import {useEffect, useState} from "react";
import {
  confirmResetPassword,
  confirmSignIn,
  resetPassword,
  signIn,
} from "aws-amplify/auth";
import {Box, Button, Callout, Flex, Heading, Text, TextField} from "@radix-ui/themes";
import Wordmark from "./Wordmark";
import "./SignIn.css";

// Mirrors the pool's password policy (template.yml CognitoUserPool): 8+ chars,
// upper, lower, number, symbols not required.
const PASSWORD_HINT = "At least 8 characters, with an uppercase letter, a lowercase letter, and a number.";

// Cognito is admin-create-only, so a brand new user's very first sign-in always
// comes back with this challenge rather than a session. It is the normal path,
// not an edge case.
const NEW_PASSWORD_STEP = "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED";

// This screen renders before anyone is authenticated, so it cannot call the API —
// every route is behind Cognito. It reads a small public sample the backend
// writes into the IIIF bucket instead. Derived from the storage variables the UI
// already has rather than adding another one.
const SHOWCASE_COUNT = 5;
const SHOWCASE_TILE = 400;
const PRESENTATION_BASE =
  import.meta.env.VITE_STORAGE_BUCKET && import.meta.env.VITE_STORAGE_REGION
    ? `https://${import.meta.env.VITE_STORAGE_BUCKET}.s3.${import.meta.env.VITE_STORAGE_REGION}.amazonaws.com`
    : "";

// A square region at a fixed size, so every tile is identical no matter the
// original aspect ratio. `square` and explicit `w,h` are level-2 Image API and
// read the same in both 2.x and 3.x, so no version branching is needed.
const squareUrl = (service) =>
  `${service.replace(/\/$/, "")}/square/${SHOWCASE_TILE},${SHOWCASE_TILE}/0/default.jpg`;

function pickRandom(items, count) {
  const pool = [...items];
  const picked = [];
  while (pool.length && picked.length < count) {
    picked.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }
  return picked;
}

// One image per work, a different five on each visit.
function useShowcase() {
  const [thumbnails, setThumbnails] = useState([]);

  useEffect(() => {
    if (!PRESENTATION_BASE) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${PRESENTATION_BASE}/working/showcase.json`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = await response.json();
        const pool = Array.isArray(data?.thumbnails) ? data.thumbnails : [];
        if (!cancelled) setThumbnails(pickRandom(pool, SHOWCASE_COUNT));
      } catch {
        // Decoration: no sample yet, or offline. The pane reads fine without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return thumbnails;
}

export default function SignIn({onSignedIn}) {
  const [step, setStep] = useState("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const fail = (err) => setError(err?.message || "Something went wrong. Try again.");

  // Amplify reports what it needs next rather than returning a session outright.
  // Anything we don't explicitly handle is surfaced instead of silently stalling.
  const handleNextStep = async (nextStep) => {
    switch (nextStep?.signInStep) {
      case "DONE":
        await onSignedIn();
        return;
      case NEW_PASSWORD_STEP:
        setPassword("");
        setStep("newPassword");
        return;
      case "RESET_PASSWORD":
        setNotice("Your password must be reset before you can sign in.");
        setStep("forgotPassword");
        return;
      default:
        setError(
          `This account needs a sign-in step this app doesn't support yet (${nextStep?.signInStep}). Contact an administrator.`,
        );
    }
  };

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submitSignIn = (event) => {
    event.preventDefault();
    setNotice(null);
    run(async () => {
      // Already-signed-in sessions make signIn throw; clear then retry once.
      const {nextStep} = await signIn({username: email.trim(), password});
      await handleNextStep(nextStep);
    });
  };

  const submitNewPassword = (event) => {
    event.preventDefault();
    run(async () => {
      const {nextStep} = await confirmSignIn({challengeResponse: newPassword});
      setNewPassword("");
      await handleNextStep(nextStep);
    });
  };

  const submitForgotPassword = (event) => {
    event.preventDefault();
    run(async () => {
      await resetPassword({username: email.trim()});
      setNotice("We emailed you a confirmation code.");
      setStep("forgotPasswordConfirm");
    });
  };

  const submitForgotPasswordConfirm = (event) => {
    event.preventDefault();
    run(async () => {
      await confirmResetPassword({
        username: email.trim(),
        confirmationCode: resetCode.trim(),
        newPassword,
      });
      setResetCode("");
      setNewPassword("");
      setNotice("Password updated. Sign in with your new password.");
      setStep("signIn");
    });
  };

  const forms = {
    signIn: {
      heading: "Sign in",
      onSubmit: submitSignIn,
      submitLabel: "Sign in",
      fields: (
        <>
          <Field label="Email">
            <TextField.Root
              type="email"
              size="3"
              value={email}
              autoComplete="username"
              autoFocus
              required
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password">
            <TextField.Root
              type="password"
              size="3"
              value={password}
              autoComplete="current-password"
              required
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </>
      ),
      footer: (
        <Button
          type="button"
          variant="ghost"
          size="2"
          onClick={() => {
            setError(null);
            setNotice(null);
            setStep("forgotPassword");
          }}
        >
          Forgot your password?
        </Button>
      ),
    },
    newPassword: {
      heading: "Choose a new password",
      description: "Your account was created with a temporary password.",
      onSubmit: submitNewPassword,
      submitLabel: "Set password and continue",
      fields: (
        <Field label="New password" hint={PASSWORD_HINT}>
          <TextField.Root
            type="password"
            size="3"
            value={newPassword}
            autoComplete="new-password"
            autoFocus
            required
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Field>
      ),
    },
    forgotPassword: {
      heading: "Reset your password",
      description: "We'll email you a confirmation code.",
      onSubmit: submitForgotPassword,
      submitLabel: "Send code",
      fields: (
        <Field label="Email">
          <TextField.Root
            type="email"
            size="3"
            value={email}
            autoComplete="username"
            autoFocus
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
      ),
      footer: <BackToSignIn onClick={() => { setError(null); setNotice(null); setStep("signIn"); }} />,
    },
    forgotPasswordConfirm: {
      heading: "Enter your code",
      onSubmit: submitForgotPasswordConfirm,
      submitLabel: "Update password",
      fields: (
        <>
          <Field label="Confirmation code">
            <TextField.Root
              size="3"
              value={resetCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              onChange={(e) => setResetCode(e.target.value)}
            />
          </Field>
          <Field label="New password" hint={PASSWORD_HINT}>
            <TextField.Root
              type="password"
              size="3"
              value={newPassword}
              autoComplete="new-password"
              required
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
        </>
      ),
      footer: <BackToSignIn onClick={() => { setError(null); setNotice(null); setStep("signIn"); }} />,
    },
  };

  const showcase = useShowcase();

  const form = forms[step];

  return (
    <Flex className="signin-screen" align="center" justify="center">
      <Box className="signin-card">
        {showcase.length > 0 && (
          <Flex className="signin-showcase" aria-hidden="true">
            {showcase.map((service) => (
              <img key={service} src={squareUrl(service)} alt="" loading="lazy" />
            ))}
          </Flex>
        )}
        <Flex direction="column" gap="1" mb="5">
          <Heading as="h1" size="6" className="app-wordmark">
            <Wordmark />
          </Heading>
          <Text as="p" size="2" color="gray">{form.description || "Sign in to manage your works."}</Text>
        </Flex>

        <form onSubmit={form.onSubmit}>
          <Flex direction="column" gap="4">
            <Heading as="h2" size="3">{form.heading}</Heading>

            {notice && (
              <Callout.Root size="1" color="blue">
                <Callout.Text>{notice}</Callout.Text>
              </Callout.Root>
            )}
            {error && (
              <Callout.Root size="1" color="red">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}

            {form.fields}

            <Button type="submit" size="3" loading={busy}>
              {form.submitLabel}
            </Button>

            {form.footer && <Flex justify="center">{form.footer}</Flex>}
          </Flex>
        </form>
      </Box>
    </Flex>
  );
}

function Field({label, hint, children}) {
  return (
    <Box>
      <Text as="label" size="2" weight="medium" className="signin-label">
        {label}
      </Text>
      {children}
      {hint && (
        <Text as="p" size="1" color="gray" mt="1">
          {hint}
        </Text>
      )}
    </Box>
  );
}

function BackToSignIn({onClick}) {
  return (
    <Button type="button" variant="ghost" size="2" onClick={onClick}>
      Back to sign in
    </Button>
  );
}
