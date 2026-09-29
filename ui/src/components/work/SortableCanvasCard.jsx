import {useSortable} from "@dnd-kit/sortable";
import {CSS} from "@dnd-kit/utilities";
import {Card, Flex, IconButton, Progress, Text, Tooltip} from "@radix-ui/themes";
import {SpeakerLoudIcon, TrashIcon, VideoIcon} from "@radix-ui/react-icons";
import InlineTextEditor from "../InlineTextEditor";
import {buildThumbnailUrlFromInfo} from "../../lib/canvasAssets";

// Radix's DragHandleDots icons are 2 columns wide; this is a 3x3 grid.
// Sized from CSS (.canvas-drag-handle svg) so it tracks the fluid scale rather
// than staying 18px inside a control that grew.
function DragHandleGridIcon() {
  const positions = [3, 8, 13];
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {positions.flatMap((cx) =>
        positions.map((cy) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.4" />),
      )}
    </svg>
  );
}

// One canvas row. Imported canvases are draggable and removable; canvases the
// import chain has not reached yet show their own progress instead — reordering
// mid-import would desync the chain, which walks canvases by index.
export default function SortableCanvasCard({
  id,
  canvas,
  index,
  disabled,
  importState,
  importPhase,
  onRenameCanvas,
  onRemoveCanvas,
}) {
  const isImported = importState === "done";
  const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({
    id,
    disabled: disabled || !isImported,
  });

  const style = {
    // Zero out x so a dragged card tracks the pointer vertically only — cheaper
    // than pulling in @dnd-kit/modifiers just for restrictToVerticalAxis.
    transform: CSS.Transform.toString(transform ? {...transform, x: 0} : null),
    transition,
  };

  const body = canvas.items?.[0]?.items?.[0]?.body;
  const serviceId = body?.service?.[0]?.id;
  // An image canvas thumbnails off its Image API service; a video canvas has
  // no service, only the poster frame the transcode wrote; audio has neither.
  const thumbnailUrl = serviceId
    ? buildThumbnailUrlFromInfo({id: serviceId})
    : canvas.thumbnail?.[0]?.id || null;
  const MediaIcon = body?.type === "Video" ? VideoIcon : body?.type === "Sound" ? SpeakerLoudIcon : null;

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={[
        "canvas-list-item",
        isDragging ? "canvas-list-item--dragging" : "",
        isImported ? "" : "canvas-list-item--importing",
      ].filter(Boolean).join(" ")}
    >
      <Flex justify="between" align="center" gap="3">
        <Flex align="center" gap="3" className="canvas-list-info">
          {isImported ? (
            <button
              type="button"
              className="canvas-drag-handle"
              aria-label="Reorder asset"
              {...attributes}
              {...listeners}
            >
              <DragHandleGridIcon />
            </button>
          ) : (
            <span className="canvas-drag-handle canvas-drag-handle--inert" aria-hidden="true">
              <DragHandleGridIcon />
            </span>
          )}
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              className="asset-dropzone-preview"
              /* Hundreds of assets means hundreds of requests otherwise; the
                 intrinsic size keeps the row from reflowing as they arrive. */
              loading="lazy"
              decoding="async"
              width="40"
              height="40"
            />
          ) : MediaIcon ? (
            <span className="asset-dropzone-preview asset-dropzone-preview--fallback" aria-hidden="true">
              <MediaIcon className="asset-dropzone-icon" />
            </span>
          ) : null}
          {isImported ? (
            <InlineTextEditor
              value={canvas.label?.none?.[0] || `Asset ${index + 1}`}
              onSave={(value) => onRenameCanvas(index, value)}
              ariaLabel="Save label"
              textProps={{weight: "bold", size: "3"}}
              fieldSize="2"
            />
          ) : (
            <Flex direction="column" gap="1" className="canvas-import-progress">
              <Text as="p" size="3" weight="bold" color="gray">
                {canvas.label?.none?.[0] || `Asset ${index + 1}`}
              </Text>
              <Text as="p" size="1" color="gray">
                {importState === "active" ? importPhase || "Importing…" : "Waiting to import…"}
              </Text>
              {/* Indeterminate while this canvas is the one being worked on. */}
              <Progress size="1" duration={importState === "active" ? "60s" : undefined}
                        value={importState === "active" ? undefined : 0}
                        max={100} />
            </Flex>
          )}
        </Flex>
        <Flex gap="2" className="canvas-list-actions">
          <Tooltip content="Remove asset">
            <IconButton
              type="button"
              variant="soft"
              color="red"
              size="1"
              onClick={() => onRemoveCanvas(index)}
              disabled={disabled || !isImported}
              aria-label="Remove asset"
            >
              <TrashIcon />
            </IconButton>
          </Tooltip>
        </Flex>
      </Flex>
    </Card>
  );
}
