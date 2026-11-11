"use client";

import dynamic from "next/dynamic";

// Loaded in the browser only, as Clover 3 had to be: the viewer draws into a
// <canvas>, and a page has nothing to show from it before then. Import the
// viewer from here, never from "@nulib/clover" directly.
//
// Every viewer in the app is Clover's Viewer in its `Document` template: a
// toolbar, the page thumbnails down the left, and the pages down one column, as
// a PDF reader shows them. Its styles are `@nulib/clover/templates.css`,
// imported in app/layout.jsx with the other global sheets.
const CloverViewer = dynamic(
  () =>
    Promise.all([import("@nulib/clover"), import("@nulib/clover/templates")]).then(
      ([clover, templates]) => {
        const Viewer = clover.default;
        function CloverDocumentViewer(props) {
          return <Viewer template={templates.Document} {...props} />;
        }
        return CloverDocumentViewer;
      },
    ),
  {ssr: false},
);

export default CloverViewer;
