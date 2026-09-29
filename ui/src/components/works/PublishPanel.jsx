import {useCallback, useEffect, useRef, useState} from "react";
import {Button, Callout, Card, Flex, Progress, Text} from "@radix-ui/themes";
import {CheckCircledIcon, ExclamationTriangleIcon, InfoCircledIcon} from "@radix-ui/react-icons";
import {COLLECTION_API_BASE, apiFetch} from "../../lib/api";
import ConsumesAside from "./ConsumesAside";
import {useReportReady} from "../../lib/pageReady";

// Publishing is two deliberate steps, and the panel's whole job is to make the
// order obvious: publish the IIIF assets, go and rebuild your static site,
// then flip the search index. Emphasis moves between the two buttons rather
// than either of them disappearing.
const POLL_MS = 4000;
const TERMINAL = new Set(["succeeded", "partial", "failed", "idle"]);

function publishUrl(slug, suffix = "") {
  if (!COLLECTION_API_BASE) return null;
  return `${COLLECTION_API_BASE}/${encodeURIComponent(slug)}/publish${suffix}`;
}

export default function PublishPanel({slug, counts, canPublish, onPublished}) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [flipping, setFlipping] = useState(false);
  const [flipped, setFlipped] = useState(null);
  const sawRunningRef = useRef(false);
  // Settled either way: a status it could not read shows as an error.
  useReportReady(!COLLECTION_API_BASE || status !== null || error !== null);

  const load = useCallback(async () => {
    const url = publishUrl(slug);
    if (!url) return null;
    try {
      const data = await apiFetch(url, {errorMessage: "Unable to read publish status"});
      setStatus(data);
      // Every row's sync state changes when a run finishes, so the list has to
      // be re-read. Keyed on the running -> terminal transition rather than on
      // the poll, so a run that finishes between two polls still triggers it
      // and a plain page load does not.
      if (!TERMINAL.has(data.status)) {
        sawRunningRef.current = true;
      } else if (sawRunningRef.current) {
        sawRunningRef.current = false;
        onPublished?.();
      }
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [slug, onPublished]);

  useEffect(() => {
    setStatus(null);
    setFlipped(null);
    load();
  }, [load]);

  // Poll only while a run is live. A publish is minutes, not seconds, so this
  // is deliberately slower than the work page's 2s import poll — and the two
  // are on different routes, so they can never both be mounted.
  useEffect(() => {
    if (!status || TERMINAL.has(status.status)) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [status, load, onPublished]);

  // Never from an effect: StrictMode double-invokes, and a run started twice
  // is two executions racing on the same collection.
  const startRun = async () => {
    setStarting(true);
    setError(null);
    try {
      await apiFetch(publishUrl(slug), {method: "POST", errorMessage: "Unable to start publishing"});
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  const flipIndex = async () => {
    setFlipping(true);
    setError(null);
    try {
      const data = await apiFetch(publishUrl(slug, "/index"), {
        method: "POST",
        errorMessage: "Unable to publish the search index",
      });
      setFlipped(data);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setFlipping(false);
    }
  };

  if (!COLLECTION_API_BASE) return null;

  const running = status && !TERMINAL.has(status.status);
  const unpublished = (counts?.new || 0) + (counts?.changed || 0);
  const neverPublished = status?.status === "idle" && !status?.liveIndex;
  const staged = Boolean(status?.canPublishIndex);

  return (
    <Card size="2" className="panel">
      {/* gap 5 between sections: the addresses, the status and the buttons
          are three different kinds of thing, and at the old 3 they ran
          together into one column. Anything that belongs to one section is
          grouped in its own Flex so it keeps a tight gap inside. */}
      <Flex direction="column" gap="5">
        {/* First: what a site is pointed at is what someone opening this
            panel most often came for. The status and the actions that change
            it follow. */}
        <ConsumesAside status={status} />

        {/* Nothing until the status is known. Falling through the chain
            with no status lands on the green "Everything is published",
            which is a claim, not a placeholder. */}
        {!status ? null : running ? (
          <Flex direction="column" gap="2">
            <Text size="2" weight="bold">{status.phase || "Publishing…"}</Text>
            {status.batches ? (
              <Progress value={status.batchesDone || 0} max={status.batches} />
            ) : (
              /* Total unknown until Plan finishes — the same indeterminate
                 treatment the import bar uses before its walk is sized. */
              <Progress size="1" duration="60s" />
            )}
            <Text size="1" color="gray">
              Edits made now will show as unpublished when this finishes.
            </Text>
          </Flex>
        ) : status?.status === "failed" ? (
          <Callout.Root color="red" size="1">
            <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
            <Callout.Text>
              Publishing failed: {status.error || "unknown error"}. The previously published
              version is untouched.{" "}
              {canPublish && (
                <Button variant="ghost" size="1" onClick={startRun} loading={starting}>
                  Retry
                </Button>
              )}
            </Callout.Text>
          </Callout.Root>
        ) : status?.status === "partial" ? (
          <Callout.Root color="orange" size="1">
            <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
            <Callout.Text>
              Published {status.published ?? 0}, {status.failed} failed.
            </Callout.Text>
          </Callout.Root>
        ) : staged ? (
          /* Every state gets a line here, this one most of all: it is the
             "go and rebuild your site" step, and with the value rows already
             filled in from an earlier flip, the panel otherwise looks done.
             Orange like unpublished changes, because it is the same kind of
             news: the live search index is behind what has been published. */
          <Callout.Root color="orange" size="1">
            <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
            <Callout.Text>
              IIIF assets published. Rebuild your site from them, then publish the search index.
            </Callout.Text>
          </Callout.Root>
        ) : neverPublished ? (
          /* Gray, not orange: an unpublished collection is a starting
             point, not something that has gone wrong. */
          <Callout.Root color="gray" size="1">
            <Callout.Icon><InfoCircledIcon /></Callout.Icon>
            <Callout.Text>Not published yet.</Callout.Text>
          </Callout.Root>
        ) : unpublished > 0 ? (
          <Callout.Root color="orange" size="1">
            <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
            <Callout.Text>
              {unpublished} work{unpublished === 1 ? " has" : "s have"} unpublished changes.
            </Callout.Text>
          </Callout.Root>
        ) : (
          <Callout.Root color="green" size="1">
            <Callout.Icon><CheckCircledIcon /></Callout.Icon>
            <Callout.Text>Everything in this collection is published.</Callout.Text>
          </Callout.Root>
        )}

        {flipped && (
          <Callout.Root color="green" size="1">
            <Callout.Text>Search index published.</Callout.Text>
          </Callout.Root>
        )}
        {error && (
          <Callout.Root color="red" size="1">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}

        {canPublish && (
          /* Directly under the status line: the status says what state the
             collection is in, and these are what change it. No container of
             their own: the buttons are already solid shapes, and a gray box
             around them was a second frame saying the same thing. Stacked in
             the order they are done, so the list itself reads as the
             sequence.

             Both solid, like every other button in the app. The variants used
             to swap to show which step was next; the second button's disabled
             state already says that, and the swap only made these two look
             unlike the rest. A column Flex stretches them to the aside's
             width. */
          <Flex direction="column" gap="2">
            <Button
              size="2"
              onClick={startRun}
              disabled={running || starting}
              loading={starting}
            >
              Publish IIIF Assets
            </Button>
            <Button
              size="2"
              onClick={flipIndex}
              disabled={!staged || running || flipping}
              loading={flipping}
            >
              Publish Search Index
            </Button>
          </Flex>
        )}

      </Flex>
    </Card>
  );
}
