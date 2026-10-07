// Radix's DragHandleDots icons are 2 columns wide; this is a 3x3 grid.
// Sized from CSS (.canvas-drag-handle svg) so it tracks the fluid scale rather
// than staying 18px inside a control that grew.
const POSITIONS = [3, 8, 13];

export default function DragHandleGridIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {POSITIONS.flatMap((cx) =>
        POSITIONS.map((cy) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.4" />),
      )}
    </svg>
  );
}
