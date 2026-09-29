import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {Spinner} from "@radix-ui/themes";
import {PageReadyContext} from "../lib/pageReady";

// Only if loading is noticeably slow. Most loads finish well inside this, and
// a spinner that flashes for 100ms is itself the kind of blip this removes.
const SPINNER_DELAY_MS = 400;
// A failed request reports ready too, so this only fires if something never
// reports at all — a bug, not a slow network. It keeps that bug from being a
// blank page.
const REVEAL_ANYWAY_MS = 10000;

// Wraps one page's content and holds it hidden until everything on it has
// loaded, then shows it all at once.
//
// Every panel on a page fetches its own data, so without this the page drew
// itself in pieces: a blank heading, "0 works", the publish panel's
// "Everything is published" before its status arrived. The route still
// changes the moment you click (the header and nav never wait); only the page
// body waits.
//
// The content is mounted while hidden, not deferred, so every panel's request
// is in flight at once and the wait is the slowest request rather than the
// sum of them. `visibility: hidden` rather than not rendering is also what
// keeps it from being focusable or clickable before it appears.
//
// `ready` is the page's own data. Anything nested reports through
// useReportReady (lib/pageReady.js).
//
// Once open it stays open. Each page component renders its own PageReady, so
// navigating to another page mounts a fresh gate — but a work that is Moved
// stays on the same WorkPage instance and does not flash.
export default function PageReady({ready = true, children}) {
  const entries = useRef(new Map());
  const revealedRef = useRef(false);
  const checkQueuedRef = useRef(false);
  const [revealed, setRevealed] = useState(false);
  const [slow, setSlow] = useState(false);

  const reveal = useCallback(() => {
    if (revealedRef.current) return;
    revealedRef.current = true;
    setRevealed(true);
  }, []);

  // Deferred to a microtask so it runs after the whole commit. Checking inside
  // the first participant's effect would open the gate before its siblings in
  // the same commit had registered.
  const queueCheck = useCallback(() => {
    if (checkQueuedRef.current || revealedRef.current) return;
    checkQueuedRef.current = true;
    queueMicrotask(() => {
      checkQueuedRef.current = false;
      for (const ready of entries.current.values()) {
        if (!ready) return;
      }
      reveal();
    });
  }, [reveal]);

  const gate = useMemo(
    () => ({
      set(id, ready) {
        entries.current.set(id, ready);
        queueCheck();
      },
      remove(id) {
        entries.current.delete(id);
        queueCheck();
      },
    }),
    [queueCheck],
  );

  // The page's own data is one more participant. This effect runs after the
  // children's, so by the time it queues a check they have all registered.
  useLayoutEffect(() => {
    gate.set("page", Boolean(ready));
    return () => gate.remove("page");
  }, [gate, ready]);

  useEffect(() => {
    if (revealed) return undefined;
    const spinner = setTimeout(() => setSlow(true), SPINNER_DELAY_MS);
    const fallback = setTimeout(reveal, REVEAL_ANYWAY_MS);
    return () => {
      clearTimeout(spinner);
      clearTimeout(fallback);
    };
  }, [revealed, reveal]);

  return (
    <PageReadyContext.Provider value={gate}>
      <div
        className="page-ready"
        data-revealed={revealed ? "" : undefined}
        aria-busy={revealed ? undefined : true}
      >
        {!revealed && slow && (
          <div className="page-ready__spinner">
            <Spinner size="3" />
          </div>
        )}
        <div className="page-ready__content">{children}</div>
      </div>
    </PageReadyContext.Provider>
  );
}
