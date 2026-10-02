"use client";

import dynamic from "next/dynamic";

// Clover's viewer pulls in OpenSeadragon, which touches `document` the moment
// it is imported, so it must never load on the server. Import the viewer from
// here, never from "@samvera/clover-iiif/viewer" directly.
const CloverViewer = dynamic(() => import("@samvera/clover-iiif/viewer"), {ssr: false});

export default CloverViewer;
