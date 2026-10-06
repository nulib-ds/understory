import {useEffect, useRef, useState} from "react";
import {Box} from "@radix-ui/themes";
import {useReportReady} from "../lib/pageReady";

// A Clover component's frame — the collection slider, a work's viewer — that
// replaces its contents without a blink.
//
// Each is rebuilt whenever its data changes (a reorder, an add, a canvas edit),
// because that is how it is made to read the new document. Rebuilt in place, it
// empties for the moment the new copy takes to load and everything below it
// jumps, then jumps back. So the new copy loads HIDDEN beside the old one, in the
// same box, and the two swap once its first cards are in. The visible copy is
// never taken away.
//
// On first load it is also a participant in the page's reveal gate
// (lib/pageReady.js): the page waits for its first cards, so it appears once,
// with this already filled, instead of filling in after the page is on screen.
//
// A copy's element is built once, when its key first appears, and kept as it was.
// Rendering every copy from the current props would hand the one on screen the
// NEW data while it is still being looked at, rebuilding it in place — the very
// thing this avoids.
//
// `cardsSelector` says what "its first cards are in" means, as a selector
// matched inside a copy.
const WAIT_MS = 4000; // longest the page waits for the first cards
const SWAP_MS = 6000; // longest a replacement is waited for before swapping anyway

export default function SwapStage({contentKey, render, cardsSelector, className = ""}) {
  const ref = useRef(null);
  const [activeKey, setActiveKey] = useState(contentKey);
  const [loaded, setLoaded] = useState(false);
  const [elements, setElements] = useState(() => ({[contentKey]: render()}));
  useReportReady(loaded);

  // Build a copy the first time its key appears (a derived-state update, which
  // React allows during render) and let go of any that is no longer shown.
  if (!(contentKey in elements)) {
    setElements((prev) => ({...prev, [contentKey]: render()}));
  }

  const incomingKey = contentKey !== activeKey ? contentKey : null;
  const layerKeys = incomingKey ? [activeKey, incomingKey] : [activeKey];

  useEffect(() => {
    setElements((prev) => {
      const kept = Object.fromEntries(Object.entries(prev).filter(([key]) => layerKeys.includes(key)));
      return Object.keys(kept).length === Object.keys(prev).length ? prev : kept;
    });
    // layerKeys is rebuilt every render; its two members are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, incomingKey]);

  // First load: let the page go anyway if the cards never come.
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  // Watch for cards arriving in a copy. Both observers, because one can become
  // ready by growing (resize) or by gaining its images (mutation).
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const hasCards = (key) =>
      Array.from(node.querySelectorAll("[data-swap-layer]")).some(
        (layer) => layer.dataset.swapLayer === key && layer.querySelector(cardsSelector),
      );
    const check = () => {
      if (hasCards(activeKey)) setLoaded(true);
      if (incomingKey && hasCards(incomingKey)) setActiveKey(incomingKey);
    };
    const resize = new ResizeObserver(check);
    const mutate = new MutationObserver(check);
    resize.observe(node);
    mutate.observe(node, {childList: true, subtree: true});
    check();
    return () => {
      resize.disconnect();
      mutate.disconnect();
    };
  }, [activeKey, incomingKey, cardsSelector]);

  // A replacement that never produces cards (an error, say) must not leave the
  // old one up forever pretending to be current.
  useEffect(() => {
    if (!incomingKey) return undefined;
    const timer = setTimeout(() => setActiveKey(incomingKey), SWAP_MS);
    return () => clearTimeout(timer);
  }, [incomingKey]);

  return (
    <Box ref={ref} className={className} style={{width: "100%"}}>
      <div className="swap-layers">
        {layerKeys.map((key) => (
          <div
            key={key}
            className="swap-layer"
            data-swap-layer={key}
            data-pending={key === activeKey ? undefined : ""}
            aria-hidden={key === activeKey ? undefined : true}
          >
            {elements[key]}
          </div>
        ))}
      </div>
    </Box>
  );
}
