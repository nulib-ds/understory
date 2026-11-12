import {useSortable} from "@dnd-kit/sortable";
import {CSS} from "@dnd-kit/utilities";
import {Card, Flex, Progress, Text} from "@radix-ui/themes";
import {SpeakerLoudIcon, TrashIcon, VideoIcon} from "@radix-ui/react-icons";
import DragHandleGridIcon from "./DragHandleGridIcon";
import ConfirmIconButton from "../ConfirmIconButton";
import {MapLanes} from "./LanguageLanes";
import {buildThumbnailUrlFromInfo} from "../../lib/canvasAssets";
import {langAttribute, resolveLanguageMap} from "../../lib/languageMap";
import {useLanguageLanes, useLanguagePreferences} from "../../lib/workLanguage";

// One canvas row. Imported canvases are draggable and removable, and their
// label is edited in language lanes, the same ones the Metadata tab uses
// (MapLanes), turned on and off by the same chips. Canvases the import chain has
// not reached yet show their own progress instead — reordering mid-import would
// desync the chain, which walks canvases by index.
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
  const preferences = useLanguagePreferences();
  const {visible} = useLanguageLanes();
  const label = resolveLanguageMap(canvas.label, preferences);
  const labelText = label.values[0] || `Asset ${index + 1}`;
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
  // An imported A/V canvas's poster has an image service of its own; an
  // uploaded one's is a plain file, used as-is below.
  const serviceId = body?.service?.[0]?.id || canvas.thumbnail?.[0]?.service?.[0]?.id;
  // An image canvas thumbnails off its Image API service; a video canvas has
  // no service, only the poster frame the transcode wrote; audio has neither.
  // Asked for at 160px tall: the card draws it at 5rem (.canvas-list-thumb),
  // twice that on a high-density screen.
  const thumbnailUrl = serviceId
    ? buildThumbnailUrlFromInfo({id: serviceId}, 160)
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
        {/* A wider gap than the row's other parts, so the thumbnail and the
            label's language lanes read as two things side by side. */}
        <Flex align="center" gap="5" className="canvas-list-info">
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
              className="asset-dropzone-preview canvas-list-thumb"
              /* Hundreds of assets means hundreds of requests otherwise; the
                 intrinsic size keeps the row from reflowing as they arrive. */
              loading="lazy"
              decoding="async"
              width="80"
              height="80"
            />
          ) : MediaIcon ? (
            <span
              className="asset-dropzone-preview asset-dropzone-preview--fallback canvas-list-thumb"
              aria-hidden="true"
            >
              <MediaIcon className="asset-dropzone-icon" />
            </span>
          ) : null}
          {isImported ? (
            // Every value of the label, in every language that is turned on.
            // A canvas label is optional, so even its last value can be
            // cleared; publishing drops a label left empty.
            <div className="canvas-label-lanes">
              <MapLanes
                map={canvas.label}
                visible={visible}
                onSave={(next) => onRenameCanvas(index, next)}
                noun="Label"
              />
            </div>
          ) : (
            <Flex direction="column" gap="1" className="canvas-import-progress">
              <Text as="p" size="3" weight="bold" color="gray" lang={langAttribute(label.key)}>
                {labelText}
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
        {/* In the card's top-right corner, like a metadata card's Remove field,
            and asking first the same way (ConfirmIconButton). */}
        <div className="canvas-list-corner">
          <ConfirmIconButton
            label="Remove asset"
            icon={<TrashIcon />}
            color="red"
            disabled={disabled || !isImported}
            onConfirm={() => onRemoveCanvas(index)}
          />
        </div>
      </Flex>
    </Card>
  );
}
