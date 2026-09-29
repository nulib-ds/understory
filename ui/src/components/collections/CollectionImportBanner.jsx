import {useEffect, useRef, useState} from "react";
import {Box, Button, Callout, Flex, Progress, Text} from "@radix-ui/themes";
import {COLLECTION_API_BASE, apiFetch} from "../../lib/api";
import {useReportReady} from "../../lib/pageReady";

const POLL_MS = 3000;

// Progress while a collection import runs.
//
// The run is a Step Functions execution, so there is nothing to keep alive here:
// this polls a status object in S3 whose progress is a count of result objects,
// which is why closing the tab, navigating away or reloading all pick the run
// back up exactly where it is.
//
// The works table beneath fills in on its own as rows are indexed — each work is
// indexed the moment it lands — so `onProgress` just asks the page to re-read it.
export default function CollectionImportBanner({slug, onProgress}) {
  const [status, setStatus] = useState(null);
  const [sawFinish, setSawFinish] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Whether the first check has come back. Until then the page waits: a
  // running import's banner appearing a beat after the page is exactly the
  // pop-in the gate exists to stop.
  const [checked, setChecked] = useState(false);
  useReportReady(!slug || !COLLECTION_API_BASE || checked);
  const wasRunning = useRef(false);
  const lastDone = useRef(-1);

  useEffect(() => {
    if (!slug || !COLLECTION_API_BASE) return undefined;
    let cancelled = false;
    let timer;

    const tick = async () => {
      try {
        const data = await apiFetch(
          `${COLLECTION_API_BASE}/${encodeURIComponent(slug)}/import`,
          {errorMessage: "Unable to read import status"},
        );
        if (cancelled) return;
        setStatus(data);
        setChecked(true);

        // Refresh the works list when a batch lands, and once more on the way
        // out — not on every tick, which would re-query for nothing.
        if (data.status === "running" && data.batchesDone !== lastDone.current) {
          lastDone.current = data.batchesDone;
          onProgress?.();
        }
        if (data.status === "running") {
          wasRunning.current = true;
          timer = setTimeout(tick, POLL_MS);
          return;
        }
        if (wasRunning.current) {
          wasRunning.current = false;
          setSawFinish(true);
          onProgress?.();
        }
      } catch {
        // A status this page cannot read is not worth an error banner: the works
        // list is the thing that matters and it reports its own failures.
        if (!cancelled) {
          setStatus(null);
          setChecked(true);
        }
      }
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, onProgress]);

  if (!status || dismissed) return null;

  const running = status.status === "running";
  const troubled = status.status === "failed" || status.status === "incomplete";
  const dropped = status.droppedAV || 0;

  // A clean run that lost nothing needs no permanent record — the works are
  // right there in the table. A failure, or anything dropped, stays up until
  // somebody dismisses it.
  if (!running && !troubled && !dropped && !sawFinish) return null;

  const total = status.total || 0;
  const completed = Math.min(status.completed || 0, total);
  const percent = total ? Math.round((completed / total) * 100) : 0;

  const color = troubled ? "red" : running ? "indigo" : "green";

  return (
    <Callout.Root color={color} size="1" mb="3">
      <Callout.Text>
        <Flex direction="column" gap="2">
          <Flex justify="between" align="center" gap="3">
            <Text size="2">
              {running
                ? `Importing ${total ? `${completed} of ${total} works` : "works"}…`
                : troubled
                  ? `Import ${status.status === "failed" ? "failed" : "finished with problems"}`
                  : `Imported ${status.imported ?? completed} work${(status.imported ?? completed) === 1 ? "" : "s"}`}
            </Text>
            {!running && (
              <Button type="button" size="1" variant="ghost" color="gray" onClick={() => setDismissed(true)}>
                Dismiss
              </Button>
            )}
          </Flex>

          {running && total > 0 && (
            <Box>
              <Progress value={percent} />
            </Box>
          )}

          {running && (
            <Text size="1" color="gray">
              You can leave this page — the run continues without it.
            </Text>
          )}

          {!running && (
            <Flex direction="column" gap="1">
              {status.error && <Text size="1">{status.error}</Text>}
              {status.failed > 0 && (
                <Text size="1">
                  {status.failed} work{status.failed === 1 ? "" : "s"} could not be imported.
                </Text>
              )}
              {status.deferred > 0 && (
                <Text size="1">
                  {status.deferred} work{status.deferred === 1 ? "" : "s"} were not reached before the
                  run ran out of time. Import the collection again to pick them up.
                </Text>
              )}
              {status.partial > 0 && (
                <Text size="1">
                  {status.partial} work{status.partial === 1 ? "" : "s"} have images that still point at
                  the source.
                </Text>
              )}
              {/* Never silent: A/V is dropped on purpose for now, and the count
                  is the only place that says so after the fact. */}
              {dropped > 0 && (
                <Text size="1">
                  {dropped} audio/video canvas{dropped === 1 ? " was" : "es were"} skipped — only images
                  are imported for now.
                </Text>
              )}
              {status.skippedCollections > 0 && (
                <Text size="1">
                  {status.skippedCollections} sub-collection
                  {status.skippedCollections === 1 ? " was" : "s were"} skipped; nested collections are
                  not followed.
                </Text>
              )}
            </Flex>
          )}
        </Flex>
      </Callout.Text>
    </Callout.Root>
  );
}
