"use client";

import dynamic from "next/dynamic";

// Loaded client-side only, like the viewer: Clover's components are built for
// the browser. Import the slider from here, never from
// "@samvera/clover-iiif/slider" directly.
const CloverSlider = dynamic(() => import("@samvera/clover-iiif/slider"), {ssr: false});

export default CloverSlider;
