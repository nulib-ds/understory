import {useState} from "react";
import NextLink from "next/link";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {CSS} from "@dnd-kit/utilities";
import {Callout, Card, Flex, IconButton, Link, Text, Tooltip} from "@radix-ui/themes";
import {TrashIcon} from "@radix-ui/react-icons";
import DragHandleGridIcon from "../work/DragHandleGridIcon";
import DeleteWorkDialog from "./DeleteWorkDialog";
import SyncStateBadge from "./SyncStateBadge";
import ImportStateBadge from "./ImportStateBadge";
import {imageRequestUrl} from "../../lib/canvasAssets";

function hideOnError(event) {
  event.currentTarget.style.visibility = "hidden";
}

// One representative image, squared. `square` region with an explicit w,h is
// level-2 Image API and reads the same in 2.x and 3.x, so every row is an
// identical square whatever the source aspect ratio — the same treatment the
// collections list and the sign-in showcase use.
//
// Requested at 2x the rendered size so it stays sharp on a retina display.
// A work with no image — an audio work, or one mid-import — keeps an empty box
// of the same size, so the titles beside it stay aligned.
function WorkThumbnail({work}) {
  const service = Array.isArray(work.thumbnails) ? work.thumbnails[0] : null;
  return service ? (
    <img
      src={imageRequestUrl(service, {region: "square", size: "80,80"})}
      alt=""
      className="asset-dropzone-preview"
      /* Thousands of works means thousands of requests otherwise; the
         intrinsic size keeps the row from reflowing as they arrive. */
      loading="lazy"
      decoding="async"
      width="40"
      height="40"
      onError={hideOnError}
    />
  ) : (
    <span className="asset-dropzone-preview work-list-thumb--empty" aria-hidden="true" />
  );
}

// One row. A work that is still being imported shows only a placeholder, its
// title and its import state: it has no handle and no trash can, because there
// is nothing to move or delete yet. Every other row is sortable — or, while a
// filter hides part of the list, carries an inert handle, so the rows do not
// shift sideways as soon as someone types.
function WorkRow({work, workPath, canReorder, reorderable, onDelete}) {
  const importing = Boolean(work.importState);
  const openable = !importing || work.importState === "ok" || work.importState === "partial";
  const sortable = !importing && canReorder && reorderable;
  const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({
    id: work.identifier,
    disabled: !sortable,
  });
  const style = {
    // Zero out x so a dragged row tracks the pointer vertically only, as the
    // asset list does.
    transform: CSS.Transform.toString(transform ? {...transform, x: 0} : null),
    transition,
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      size="1"
      className={["canvas-list-item", isDragging ? "canvas-list-item--dragging" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <Flex justify="between" align="center" gap="3">
        <Flex align="center" gap="3" className={`work-list-info${importing ? "" : " canvas-list-info"}`}>
          {!importing &&
            (sortable ? (
              <button
                type="button"
                className="canvas-drag-handle"
                aria-label="Reorder work"
                {...attributes}
                {...listeners}
              >
                <DragHandleGridIcon />
              </button>
            ) : (
              <span className="canvas-drag-handle canvas-drag-handle--inert" aria-hidden="true">
                <DragHandleGridIcon />
              </span>
            ))}
          <WorkThumbnail work={work} />
          {openable ? (
            <Link asChild size="3" weight="bold">
              <NextLink href={workPath(work.identifier)} prefetch={false}>
                {work.label || work.identifier}
              </NextLink>
            </Link>
          ) : (
            <Text size="3" className="import-pending-title">
              {work.label || work.identifier}
            </Text>
          )}
        </Flex>
        <Flex align="center" gap="3" className="work-list-status">
          {/* Always visible: a status you have to hover to see is not a status. */}
          {importing ? (
            <ImportStateBadge state={work.importState} />
          ) : (
            <SyncStateBadge state={work.syncState} />
          )}
          {!importing && (
            <Tooltip content="Delete work">
              <IconButton
                type="button"
                variant="soft"
                color="red"
                size="1"
                onClick={() => onDelete(work)}
                aria-label="Delete work"
              >
                <TrashIcon />
              </IconButton>
            </Tooltip>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}

// The collection's works as a list of cards, the way a work's assets are: a drag
// handle, a thumbnail, a title, the work's status on the right and a trash can.
// The order is the collection's own, kept in its leaf document (see "Order" in
// shared/collection.js), and a drag reports one move: this work, after that one.
// Only the rows that have loaded can be moved among — the list arrives a page at
// a time — and nothing is movable while a filter is hiding part of it.
//
// There is no Collection column: every row here is in the same collection.
export default function WorksTable({
  works,
  onDelete,
  onMoveWork,
  workPath,
  filtered,
  canReorder = false,
  loading,
  error,
}) {
  const [pendingDelete, setPendingDelete] = useState(null);
  const sensors = useSensors(
    // A small threshold keeps a click on the handle a click.
    useSensor(PointerSensor, {activationConstraint: {distance: 5}}),
    useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}),
  );

  if (loading) {
    return <Text as="p" size="2" color="gray">Loading works…</Text>;
  }

  if (error) {
    return (
      <Callout.Root color="red" size="1">
        <Callout.Text>{error}</Callout.Text>
      </Callout.Root>
    );
  }

  const rows = works || [];
  if (rows.length === 0) {
    return filtered ? (
      <Text as="p" size="2" color="gray">No works match that filter.</Text>
    ) : (
      <Text as="p" size="2" color="gray" className="tree-empty">No works in this collection yet.</Text>
    );
  }

  const handleDragEnd = ({active, over}) => {
    if (!over || active.id === over.id) return;
    const from = rows.findIndex((work) => work.identifier === active.id);
    const to = rows.findIndex((work) => work.identifier === over.id);
    if (from === -1 || to === -1) return;
    const moved = arrayMove(rows, from, to);
    onMoveWork?.(active.id, to === 0 ? null : moved[to - 1].identifier);
  };

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={rows.map((work) => work.identifier)}
          strategy={verticalListSortingStrategy}
        >
          <Flex direction="column" gap="2" className="work-list">
            {rows.map((work) => (
              <WorkRow
                key={work.identifier}
                work={work}
                workPath={workPath}
                canReorder={canReorder && Boolean(onMoveWork)}
                reorderable={!filtered}
                onDelete={setPendingDelete}
              />
            ))}
          </Flex>
        </SortableContext>
      </DndContext>
      <DeleteWorkDialog
        work={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async (identifier) => {
          await onDelete(identifier);
          setPendingDelete(null);
        }}
      />
    </>
  );
}
