"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {Box, Heading} from "@radix-ui/themes";
import {ROLE_ADMIN, useSession} from "../lib/session";
import Wordmark from "./Wordmark";

// The app's top-level sections. Order here is the order on the page.
//
// Each carries its own `match` because prefix matching cannot express what the
// collections tab needs: as a prefix, "/" lights on every path, /users
// included; as an exact match, it goes dark on /collection/:slug. So each
// section decides for itself.
//
// Adding a section means one entry here, one `match`, and one route folder
// under src/app/(app)/.
const SECTIONS = [
  {
    path: "/",
    label: "Collections",
    match: (p) => p === "/" || p === "/collections" || p.startsWith("/collection/"),
  },
  // Admin-only. Hiding it is a courtesy, not the control: /users is refused by
  // the API for anyone else, and the page says so if they navigate there.
  {path: "/users", label: "Users", adminOnly: true, match: (p) => p.startsWith("/users")},
];

// aria-current is set by hand, from the same `match`, so the tab that looks
// active is the one announced as current.
function SectionNav() {
  const {role} = useSession();
  const pathname = usePathname();
  const visible = SECTIONS.filter((section) => !section.adminOnly || role === ROLE_ADMIN);

  return (
    <nav className="section-nav" aria-label="Sections">
      {visible.map((section) => {
        const isActive = section.match(pathname);
        return (
          <Link
            key={section.path}
            href={section.path}
            className={`section-link${isActive ? " section-link--active" : ""}`}
            aria-current={isActive ? "page" : undefined}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}

// Every signed-in route renders inside this: the purple bar, the page container
// and the app wordmark are identical across sections, so they live here once
// instead of in each screen.
export default function AppShell({children}) {
  const {signOut, username} = useSession();
  return (
    <>
      {/* Full-bleed purple utility bar, mirroring the one at the top of
          library.northwestern.edu. Its contents align to the same container
          width as the page below it. */}
      <header className="nu-header">
        <div className="nu-header-inner">
          <a className="nu-wordmark" href="https://www.northwestern.edu/">
            {/* The wordmark is a background image, so keep the name available to
                screen readers — same approach the Northwestern sites use. */}
            <span className="nu-wordmark-label">Northwestern</span>
          </a>
          {signOut && (
            <div className="nu-header-session">
              {username && (
                <>
                  <span className="nu-header-session__user">Signed in as {username}</span>
                  {/* Decoration, not content — a screen reader reading "vertical
                      line" between the two is noise. */}
                  <span className="nu-header-session__divider" aria-hidden>
                    |
                  </span>
                </>
              )}
              <button type="button" className="nu-header-signout" onClick={signOut}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="layout">
        <div className="layout-container">
          <div className="layout-header">
            {/* The link goes inside the h1, not around it: the heading stays
                the page's h1 and the link is its content. */}
            <Heading as="h1" size="6" className="app-wordmark">
              <Link href="/">
                <Wordmark />
              </Link>
            </Heading>
            <SectionNav />
          </div>
          <Box pt="2">{children}</Box>
        </div>
      </main>
    </>
  );
}
