import {useCallback, useRef, useState} from "react";
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
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {Box, Callout, Flex, Text} from "@radix-ui/themes";
import AssetDropzone from "../AssetDropzone";
import SortableCanvasCard from "./SortableCanvasCard";

// How many asset cards to mount at a time. See below for why this is bounded
// rather than rendering every canvas.
//
// This MUST live in the same module as the component: in App.jsx it sat 500
// lines away, between two unrelated components, and worked only by module-scope
// hoisting.
const CANVAS_WINDOW_STEP = 40;

export default function CanvasList({
  detail,
  loading,
  error,
  onAttachAssets,
  canAddCanvas,
  onMoveCanvas,
  onRemoveCanvas,
  onRenameCanvas,
  importStatus,
  canvasSaving,
  canvasActionError,
  disableAddReason,
}) {
  // Reset the window when the work changes, and grow it as the sentinel below
  // the list scrolls into view.
  const [visibleCount, setVisibleCount] = useState(CANVAS_WINDOW_STEP);
  const observerRef = useRef(null);
  const identifier = detail?.identifier;

  // Adjusting state during render rather than in an effect: React re-renders
  // immediately with the new value, so the window never paints at the previous
  // work's size.
  const [windowedWork, setWindowedWork] = useState(identifier);
  if (identifier !== windowedWork) {
    setWindowedWork(identifier);
    setVisibleCount(CANVAS_WINDOW_STEP);
  }

  // A callback ref rather than useEffect + useRef: this component returns early
  // while the work is loading, so the sentinel does not exist on mount and a
  // mount effect would find nothing to observe and never run again.
  const sentinelRef = useCallback((node) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      // Growing the list mid-drag would hand dnd-kit sortables it has not
      // measured, so leave the window alone until the drag finishes.
      if (document.querySelector(".canvas-list-item--dragging")) return;
      setVisibleCount((count) => count + CANVAS_WINDOW_STEP);
      // The sentinel node is reused across reveals, so re-arm it: without this,
      // a sentinel that stays on screen never reports a new intersection and
      // the list stops growing.
      observer.unobserve(node);
      observer.observe(node);
    }, {rootMargin: "400px"});
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  const sensors = useSensors(
    // A small threshold keeps a click on the handle a click, and stops clicks on
    // the label editor from being swallowed as drags.
    useSensor(PointerSensor, {activationConstraint: {distance: 5}}),
    useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}),
  );

  if (loading) {
    return <Text as="p" color="gray" className="manifest-detail-placeholder">Loading work…</Text>;
  }

  if (error) {
    return (
      <Callout.Root color="red" size="1">
        <Callout.Text>{error}</Callout.Text>
      </Callout.Root>
    );
  }

  if (!detail) {
    return <Text as="p" color="gray" className="manifest-detail-placeholder">Select a work to edit assets.</Text>;
  }

  const canvases = Array.isArray(detail.manifest?.items)
    ? detail.manifest.items
    : [];
  const canvasIds = canvases.map((canvas, index) => canvas.id || `canvas-${index}`);

  // Only render a window of cards. dnd-kit measures the rect of every mounted
  // sortable when a drag starts, and that cost is linear in how many there are —
  // measured at ~1.9ms each, so 271 cards stalled the first frame of a drag for
  // over half a second. Rendering 40 keeps that under ~80ms.
  //
  // The trade-off is real and deliberate: you can only reorder among the cards
  // that are rendered. Scrolling reveals more.
  const visible = Math.min(visibleCount, canvases.length);
  const visibleCanvasIds = canvasIds.slice(0, visible);
  const hasMore = visible < canvases.length;

  // Ten canvases copy at once and finish in whatever order they finish, so
  // "everything below N is done" would be a lie. The status carries which
  // canvases are actually done and what each in-flight one is doing.
  //
  // Plain const, not useMemo: this sits below the component's early returns, and
  // building a set of a few hundred integers per render costs nothing.
  const importDone = new Set(Array.isArray(importStatus?.done) ? importStatus.done : []);
  const canvasImportState = (index) => {
    if (!importStatus) return {state: "done", phase: null};
    const active = importStatus.active;
    if (active && Object.prototype.hasOwnProperty.call(active, index)) {
      return {state: "active", phase: active[index]};
    }
    if (Array.isArray(importStatus.done)) {
      return {state: importDone.has(index) ? "done" : "pending", phase: null};
    }
    // A status object written before per-canvas progress existed: fall back to
    // the old single-cursor shape so an import already in flight still reads.
    const completed = importStatus.completed ?? 0;
    if (index < completed) return {state: "done", phase: null};
    if (index === (importStatus.currentIndex ?? completed)) {
      return {state: "active", phase: importStatus.phase};
    }
    return {state: "pending", phase: null};
  };

  const handleDragEnd = ({active, over}) => {
    if (!over || active.id === over.id) return;
    const from = canvasIds.indexOf(active.id);
    const to = canvasIds.indexOf(over.id);
    if (from === -1 || to === -1) return;
    onMoveCanvas(from, to);
  };

  return (
    <Box className="manifest-detail">
      <AssetDropzone
        workId={detail.identifier}
        manifest={detail.manifest}
        disabled={!canAddCanvas}
        disabledReason={disableAddReason}
        onAttach={onAttachAssets}
      />
      {canvasActionError && (
        <Callout.Root color="red" size="1">
          <Callout.Text>{canvasActionError}</Callout.Text>
        </Callout.Root>
      )}
      {canvasSaving && (
        <Callout.Root color="iris" size="1">
          <Callout.Text>Saving assets…</Callout.Text>
        </Callout.Root>
      )}
      <Box className="manifest-detail-body">
        {canvases.length === 0 ? (
          <Text as="p" size="2">
            {canAddCanvas
              ? "No assets yet. Add one to start building the viewing order."
              : "No assets yet."}
          </Text>
        ) : (
          <DndContext
            // A fixed id: dnd-kit otherwise numbers its aria ids from a module
            // counter, which a server render and the browser count differently.
            id="canvas-list"
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={visibleCanvasIds} strategy={verticalListSortingStrategy}>
              <Flex direction="column" gap="2" className="canvas-list">
                {canvases.slice(0, visible).map((canvas, index) => {
                  const {state, phase} = canvasImportState(index);
                  return (
                    <SortableCanvasCard
                      key={canvasIds[index]}
                      id={canvasIds[index]}
                      canvas={canvas}
                      index={index}
                      disabled={canvasSaving}
                      importState={state}
                      importPhase={phase}
                      onRenameCanvas={onRenameCanvas}
                      onRemoveCanvas={onRemoveCanvas}
                    />
                  );
                })}
              </Flex>
            </SortableContext>
            {hasMore && (
              <Flex ref={sentinelRef} justify="center" py="4">
                <Text size="2" color="gray">
                  Showing {visible} of {canvases.length} assets…
                </Text>
              </Flex>
            )}
          </DndContext>
        )}
      </Box>
    </Box>
  );
}
