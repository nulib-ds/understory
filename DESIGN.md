# Design

## UI component library: Radix Themes

The `ui/` frontend is standardizing on [Radix Themes](https://www.radix-ui.com/themes/docs/overview/getting-started) for its component layer.

Going forward, new UI should be built with Radix Themes components (`Button`, `Card`, `Dialog`, `TextField`, `Callout`, `Flex`, `Box`, `Heading`, `Text`, etc.) rather than hand-rolled markup and CSS. Existing hand-rolled elements are being swapped out incrementally — there is no requirement to migrate everything in one pass. When touching a component that still uses raw HTML/custom CSS, prefer converting it to the equivalent Radix Themes component while you're in there, but don't block unrelated work on finishing the migration.

### Theme configuration

The app is wrapped in a single `<Theme>` provider (the root layout, `ui/src/app/layout.jsx`) with:

- `appearance="light"`
- `accentColor="iris"`
- `grayColor="mauve"`
- `scaling="110%"`

Any new top-level provider usage (e.g. rendering outside the root layout, such as in tests or a Storybook-style harness) should reuse these same props so components look consistent wherever they're rendered.

### What's already migrated

- App shell layout, headings, and body text (`Heading`, `Text`, `Flex`, `Box`)
- Buttons (`Button`)
- Form fields (`TextField.Root`)
- Modals (`Dialog.Root` / `Dialog.Content`)
- Status/error messaging (`Callout.Root`)
- Panel containers (`Card`)
- Top-level navigation between Works/Assets (`Tabs.Root` / `Tabs.List` / `Tabs.Trigger` / `Tabs.Content`)

### What's still custom

- `StorageBrowser` (`@aws-amplify/ui-react-storage`) and `CloverViewer` (`@samvera/clover-iiif`) are third-party embeds with their own styling and are out of scope for Radix conversion — they're framed by Radix `Card`/`Box` but their internals are left alone.
- The manifest list/canvas list items still lean on some bespoke CSS in `ui/src/App.css` for layout details Radix doesn't cover out of the box (e.g. active-state list item treatment). Prefer trimming this custom CSS as more of the surrounding markup moves to Radix primitives, rather than growing it.
