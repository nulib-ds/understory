# Branding

Everything in this folder is published at `/branding/` on the admin UI, with
every deploy. Each file is optional; with none, the top bar shows
`InstitutionName` in `AccentColor`.

| File | What it does |
|---|---|
| `theme.css` | Loaded after the app's own CSS. Redefine the documented tokens: `--accent-1` to `--accent-12`, `--gray-1` to `--gray-12`, `--brand-bar-bg`, `--brand-bar-fg`, `--brand-mark-height`. |
| `header.html` | The left of the top bar, in place of the institution name. Usually a logo in a link. |
| `footer.html` | A footer under every signed-in page. |
| `sign-in.html` | Text on the sign-in card: who the site is for, who to ask for an account. |
| `favicon.svg`, `favicon.png` or `favicon.ico` | The browser tab icon. |
| anything else | Published as is, for the files above to reference, e.g. `/branding/assets/logo.svg`. |

The snippets are HTML, rendered without scripts or styles of their own:
`a`, `b`, `br`, `div`, `em`, `i`, `img`, `li`, `ol`, `p`, `small`, `span`,
`strong`, `sub`, `sup` and `ul`, with `class`, `title` and `aria-label` on any
of them. Links may be `http`, `https`, `mailto` or a path on this site;
images `http`, `https` or a path on this site.

The slots, tokens and the `/branding/` path are part of each release's
contract: renaming or removing one is a major version. The app's own class
names are not, so styling them may break on any upgrade.

This README is never published.
