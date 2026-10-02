import {Theme} from "@radix-ui/themes";
// Every global stylesheet, imported once, here, in cascade order. Next loads a
// layout's CSS before the CSS of the pages beneath it, so a sheet imported from
// a component would land after App.css and reverse the order the app depends
// on: Radix first, the theme and fonts on top of it, App.css (the fluid scale,
// the tokens and the overrides) last. Do not import global CSS anywhere else.
import "@radix-ui/themes/styles.css";
import "../theme.css";
import "@fontsource/google-sans/400.css";
import "@fontsource/google-sans/500.css";
import "@fontsource/google-sans/600.css";
import "@fontsource/google-sans/700.css";
// Headings only. The weight-axis cut of Google Sans Flex (1-1000) is ~50KB; the
// all-axes build that would also bring the optical-size axis is 1.4MB, which is
// not worth it for a heading face.
import "@fontsource-variable/google-sans-flex/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "../index.css";
import "../components/AssetDropzone.css";
import "../components/SignIn.css";
import "../App.css";

export const metadata = {
  title: "Understory",
  icons: {icon: "/favicon.svg"},
};

export default function RootLayout({children}) {
  return (
    <html lang="en">
      <body>
        <Theme appearance="light" accentColor="iris" grayColor="mauve" scaling="110%">
          {children}
        </Theme>
      </body>
    </html>
  );
}
