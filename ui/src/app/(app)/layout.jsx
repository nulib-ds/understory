import AuthGate from "../../AuthGate";
import AppShell from "../../components/AppShell";

// Every signed-in route renders inside this: AuthGate decides between the
// sign-in screen and the app, and AppShell draws the header, the section menu
// and the page container once for all of them.
export default function SignedInLayout({children}) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
