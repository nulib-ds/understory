import {useId} from "react";

// The Understory mark: three stacked layers, the top one cut through with a U.
//
// Inline rather than an <img>, so it is drawn in currentColor and is exactly
// the colour of the word beside it — black in the header, and whatever the
// wordmark is ever set to. The viewBox is cropped to the drawing itself: the
// source file is 512 square with ~66 units of air on every side, which would
// leave the mark floating away from the type instead of sitting against it.
//
// The mask's white and black are luminance (keep / cut), not colours anyone
// sees, which is why they are not theme tokens. Its id comes from useId so a
// second copy on a page (header and sign-in are never both mounted, but
// nothing stops it) cannot resolve to the other's mask.
function UnderstoryMark() {
  const maskId = `understory-u-cut-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      className="app-lockup__mark"
      viewBox="65 74 382 364"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect x="-100" y="-300" width="800" height="1000" fill="white" />
          <path
            d="M-28 -33 L-28 5 A28 28 0 0 0 28 5 L28 -33"
            transform="matrix(1 0.5 -1 0.5 256 315)"
            fill="none"
            stroke="black"
            strokeWidth="15"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <g transform="translate(-76.8 -228.9) scale(1.3)">
        <path
          d="M256 250 L386 315 L256 380 L126 315 Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="32"
          strokeLinejoin="round"
          mask={`url(#${maskId})`}
        />
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="32"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M126 373 L256 438 L386 373" />
          <path d="M126 431 L256 496 L386 431" />
        </g>
      </g>
    </svg>
  );
}

// The horizontal lockup: mark, then the word. Used by the header and the
// sign-in pane, so the two cannot drift apart. The mark is aria-hidden — the
// word is the accessible name, and "Understory Understory" helps nobody.
export default function Wordmark() {
  return (
    <span className="app-lockup">
      <UnderstoryMark />
      <span>Understory</span>
    </span>
  );
}
