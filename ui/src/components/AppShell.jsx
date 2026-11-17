"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {Box, Heading, Link as RadixLink} from "@radix-ui/themes";
import {ROLE_ADMIN, useSession} from "../lib/session";
import {useBranding} from "../lib/branding";
import {renderSnippetHtml} from "../lib/iiifHtml";
import Wordmark from "./Wordmark";

// The app's top-level sections. Order here is the order on the page.
//
// Each carries its own `match` because prefix matching cannot express what the
// collections tab needs: as a prefix, "/" lights on every path, /users
// included; as an exact match, it goes dark on /collection. So each
// section decides for itself.
//
// Adding a section means one entry here, one `match`, and one route folder
// under src/app/(app)/.
const SECTIONS = [
  {
    path: "/",
    label: "Collections",
    match: (p) => p === "/" || p.startsWith("/collection"),
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
          <RadixLink
            key={section.path}
            asChild
            underline="auto"
            className={`section-link${isActive ? " section-link--active" : ""}`}
          >
            <Link
              href={section.path}
              aria-current={isActive ? "page" : undefined}
              data-label={section.label}
            >
              {section.label}
            </Link>
          </RadixLink>
        );
      })}
    </nav>
  );
}

// Every signed-in route renders inside this: the brand bar, the page container,
// the app wordmark and the session strip are identical across sections, so
// they live here once instead of in each screen.
// The institution's mark in the brand bar: its header.html snippet when the
// instance has one, its name otherwise, and nothing at all with neither.
function BrandMark() {
  const {header, institutionName} = useBranding();
  const snippet = renderSnippetHtml(header);
  if (snippet) return <div className="brand-mark">{snippet}</div>;
  if (institutionName) {
    return (
      <div className="brand-mark">
        <span className="brand-mark__name">{institutionName}</span>
      </div>
    );
  }
  return null;
}

function SiteFooter() {
  const {footer} = useBranding();
  const snippet = renderSnippetHtml(footer);
  if (!snippet) return null;
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">{snippet}</div>
    </footer>
  );
}

export default function AppShell({children}) {
  const {signOut, username} = useSession();
  return (
    <>
      {/* The brand bar: a full-bleed utility bar in the accent colour, carrying the
          institution's mark. Its contents align to the same container width as
          the page below it. */}
      <header className="brand-bar">
        <div className="brand-bar__inner">
          <BrandMark />
        </div>
      </header>
      <main className="layout">
        <div className="layout-container">
          <div className="layout-header">
            {/* Who is signed in sits beside the wordmark, so identity reads as
                one group and the sections stand alone on the right. */}
            <div className="layout-header__identity">
              {/* The link goes inside the h1, not around it: the heading stays
                  the page's h1 and the link is its content. */}
              <Heading as="h1" size="6" className="app-wordmark">
                <Link href="/">
                  <Wordmark />
                </Link>
              </Heading>
              {signOut && (
                <div className="session-strip">
                  {username && (
                    <>
                      <span className="session-strip__user">Signed in as {username}</span>
                      {/* Decoration, not content — a screen reader reading "vertical
                          line" between the two is noise. */}
                      <span className="session-strip__divider" aria-hidden>
                        |
                      </span>
                    </>
                  )}
                  <RadixLink asChild underline="auto">
                    <button type="button" className="session-strip__signout" onClick={signOut}>
                      Sign out
                    </button>
                  </RadixLink>
                </div>
              )}
            </div>
            <SectionNav />
          </div>
          <Box pt="2">{children}</Box>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
