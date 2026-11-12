// The Clover Viewer's options (@nulib/clover's Document template, see
// components/CloverViewer.jsx), shared by every viewer in the app. Its colours
// are not here: Clover reads them from `--clover-color-*` custom properties,
// which App.css sets from the Radix theme.
export const CLOVER_OPTIONS = {
  // Collapsed on load; its toolbar button keeps the reader's control to open it.
  // Document's own default too, stated so it survives a change of template.
  defaultPanelOpen: false,
};
