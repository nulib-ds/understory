"use client";

import dynamic from "next/dynamic";

// The collection's works as a masonry grid: @nulib/clover's `Items`, standalone
// (the successor to 3.x's Slider), with `layout="masonry"`, a grid whose
// pictures keep their own proportions, each packed up under the one above, in
// reading order. Loaded client-side only, like the viewer. Import it from here,
// never from "@nulib/clover" directly.
const CloverItems = dynamic(() => import("@nulib/clover").then((clover) => clover.Items), {
  ssr: false,
});

// Each member is a link Clover points at the member's `homepage`, or failing
// that its id — the manifest JSON. Ours have no homepage, so following one would
// open raw JSON: the click is stopped and handed to `onSelect` instead.
export default function CloverSlider({iiifContent, onSelect}) {
  return (
    <CloverItems
      iiifContent={iiifContent}
      layout="masonry"
      // The page heading already names the collection.
      header={false}
      onSelect={(item, event) => {
        event.preventDefault();
        onSelect?.(item);
      }}
      className="collection-items"
    />
  );
}
