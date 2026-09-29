import {useCallback, useEffect, useRef, useState} from "react";
import {uploadData} from "aws-amplify/storage";
import {ImageIcon, SpeakerLoudIcon, TrashIcon, UploadIcon, VideoIcon} from "@radix-ui/react-icons";
import {AlertDialog, Box, Button, Callout, Em, Flex, IconButton, Progress, Text, TextField} from "@radix-ui/themes";
import {apiFetch, manifestApiUrl} from "../lib/api";
import {
  assetLabelFromKey,
  buildAvCanvasResource,
  buildCanvasResource,
  buildInfoUrlFromKey,
  buildMediaStatusUrl,
  buildThumbnailUrlFromInfo,
  mediaKindFromFile,
} from "../lib/canvasAssets";
import "./AssetDropzone.css";

const SOURCE_BUCKET = import.meta.env.VITE_SOURCE_BUCKET || "";
const STORAGE_REGION = import.meta.env.VITE_STORAGE_REGION || import.meta.env.VITE_AWS_REGION || "";

// Amplify's default configured Storage bucket (VITE_STORAGE_BUCKET) is the IIIF
// *output* bucket — uploads need to go to the separate *source* bucket instead
// (the one the iiif-image Lambda watches), so every uploadData call must target
// it explicitly rather than relying on the default.
const SOURCE_BUCKET_TARGET = {bucketName: SOURCE_BUCKET, region: STORAGE_REGION};

// A freshly uploaded file still needs the S3-triggered iiif-image Lambda to produce
// a pyramid TIFF before serverless-iiif can serve its info.json — poll for it as soon
// as the upload finishes (rather than waiting for "Add to work") so processing has a
// head start and the real, always-renderable IIIF thumbnail can replace the local preview.
const INFO_POLL_INTERVAL_MS = 1500;
const INFO_POLL_ATTEMPTS = 14; // ~20s of retrying

// Audio/video goes through MediaConvert, which takes minutes rather than
// seconds — roughly real time or faster, plus a queue wait — so it is polled
// far less often. media.json is written no-cache, so a poll sees a change
// within CloudFront's 1s floor.
//
// There is no deadline. This used to give up after 45 minutes and report an
// error for a job that was still running; now the poll simply lasts as long
// as the page does, and a job that outlives it is picked up by recovery on the
// next visit.
const MEDIA_POLL_INTERVAL_MS = 5000;

const FALLBACK_ICONS = {image: ImageIcon, video: VideoIcon, audio: SpeakerLoudIcon};

// Most browsers can't decode TIFF (the usual source format for this pipeline) via <img>,
// so the local blob preview silently fails to render for it — fall back to a generic icon
// rather than leaving a blank/broken image in its place. `key` on the call site remounts
// this (resetting `failed`) whenever the source swaps from the local blob to the real
// IIIF thumbnail once processing finishes.
function PendingPreview({src, kind}) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    const Icon = FALLBACK_ICONS[kind] || ImageIcon;
    return (
      <Box className="asset-dropzone-preview asset-dropzone-preview--fallback">
        <Icon className="asset-dropzone-icon" />
      </Box>
    );
  }
  return <img src={src} alt="" className="asset-dropzone-preview" onError={() => setFailed(true)} />;
}

function extensionFromFilename(name) {
  const match = /\.[^./]+$/.exec(name || "");
  return match ? match[0].toLowerCase() : "";
}

async function waitForImageInfo(key) {
  const infoUrl = buildInfoUrlFromKey(key);
  if (!infoUrl) {
    throw new Error("VITE_IIIF_BASE_URL is not configured");
  }
  for (let attempt = 0; attempt < INFO_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(infoUrl).catch(() => null);
    if (response?.ok) {
      return response.json();
    }
    await new Promise((resolve) => setTimeout(resolve, INFO_POLL_INTERVAL_MS));
  }
  throw new Error("Image is still processing — try again in a moment");
}

// A 404 is expected for the first moment after upload, before the Lambda has
// written "processing"; anything but ready or error keeps polling. Resolves
// null once `isActive()` goes false, so an unmounted dropzone stops fetching.
//
// isActive is checked AFTER each wait, never before the first fetch: recovery
// adds items and starts their pollers in the same tick, before a render has
// put them in pendingRef, so a check up front would see nothing and quit.
async function waitForMediaStatus(statusUrl, isActive) {
  if (!statusUrl) {
    throw new Error("Unable to locate this work's media — reload and try again");
  }
  for (;;) {
    const response = await fetch(statusUrl, {cache: "no-store"}).catch(() => null);
    if (response?.ok) {
      const status = await response.json().catch(() => null);
      if (status?.status === "ready") return status;
      if (status?.status === "error") {
        throw new Error(status.error || "Transcoding failed");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, MEDIA_POLL_INTERVAL_MS));
    if (!isActive()) return null;
  }
}

function isAvKind(kind) {
  return kind === "video" || kind === "audio";
}

// One row from GET /manifests/{id}/media -> a pending item. Its tempId IS the
// assetId, because the upload key was built from the tempId in the first
// place — which is also what lets an item uploaded this visit and the same
// item coming back from recovery be recognised as one.
function pendingFromRecovered(entry) {
  const media = entry.media || {};
  const filename = media.filename || null;
  return {
    tempId: entry.assetId,
    file: null,
    filename,
    kind: entry.kind,
    key: entry.key,
    label: filename ? assetLabelFromKey(filename) : "",
    status: media.status === "ready" ? "ready" : media.status === "error" ? "error" : "processing",
    progress: 100,
    previewUrl: null,
    imageInfo: null,
    media: media.status === "ready" ? media : null,
    errorMessage: media.status === "error" ? media.error || "Transcoding failed" : null,
    recovered: true,
  };
}

export default function AssetDropzone({workId, manifest, disabled, disabledReason, onAttach}) {
  const [pending, setPending] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState(null);
  const [discardError, setDiscardError] = useState(null);
  const [recoveryError, setRecoveryError] = useState(null);
  const fileInputRef = useRef(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  // Read through a ref so the recovery effect runs once per work rather than
  // after every save: all it needs from the manifest is its base URL.
  const manifestRef = useRef(manifest);
  manifestRef.current = manifest;
  const mountedRef = useRef(true);
  // In-flight Amplify upload tasks, so removing an uploading item cancels it
  // (and Amplify aborts the multipart upload) instead of just hiding it.
  const uploadTasksRef = useRef(new Map());
  // One poller per asset: recovery and an upload finishing can both ask.
  const pollingRef = useRef(new Set());

  useEffect(() => {
    mountedRef.current = true;
    const tasks = uploadTasksRef.current;
    return () => {
      mountedRef.current = false;
      pendingRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      // Deliberately NOT cancelled: leaving the page within the app should not
      // throw away a half-sent upload. It finishes in the background and comes
      // back through recovery. Only the tab closing stops it (see below).
      tasks.clear();
    };
  }, []);

  const uploading = pending.some((item) => item.status === "uploading");

  // Closing the tab is the one way to lose work outright: the upload stops,
  // and a later attempt starts over from zero. Leaving after the upload has
  // finished loses nothing, so the prompt is only armed while one is sending.
  useEffect(() => {
    if (!uploading) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const updatePending = useCallback((tempId, patch) => {
    setPending((prev) =>
      prev.map((item) => (item.tempId === tempId ? {...item, ...patch} : item)),
    );
  }, []);

  const resolveImageInfo = useCallback(
    async (tempId, key) => {
      try {
        const info = await waitForImageInfo(key);
        updatePending(tempId, {status: "ready", imageInfo: info});
      } catch (err) {
        updatePending(tempId, {status: "error", errorMessage: err.message || "Unable to process image"});
      }
    },
    [updatePending],
  );

  const resolveMediaStatus = useCallback(
    async (tempId, key) => {
      if (pollingRef.current.has(tempId)) return;
      pollingRef.current.add(tempId);
      try {
        const media = await waitForMediaStatus(
          buildMediaStatusUrl(manifestRef.current, key),
          // Stops when the page goes, or when this item is discarded.
          () => mountedRef.current && pendingRef.current.some((item) => item.tempId === tempId),
        );
        if (media) updatePending(tempId, {status: "ready", media});
      } catch (err) {
        updatePending(tempId, {status: "error", errorMessage: err.message || "Unable to process media"});
      } finally {
        pollingRef.current.delete(tempId);
      }
    },
    [updatePending],
  );

  // Recovery: whatever was uploaded to this work but never attached — because
  // the page was left mid-transcode, or before "Add to work", or because its
  // canvas was later removed. See mediaRoutes.js; nothing is stored for this.
  useEffect(() => {
    if (disabled || !workId) return undefined;
    const url = manifestApiUrl(`${encodeURIComponent(workId)}/media`);
    if (!url) return undefined;
    let cancelled = false;
    apiFetch(url, {errorMessage: "Unable to check for unfinished uploads"})
      .then(({media = []}) => {
        if (cancelled) return;
        setRecoveryError(null);
        const known = new Set(pendingRef.current.map((item) => item.tempId));
        const recovered = media.map(pendingFromRecovered).filter((item) => !known.has(item.tempId));
        if (recovered.length === 0) return;
        setPending((prev) => [...prev, ...recovered]);
        recovered
          .filter((item) => item.status === "processing")
          .forEach((item) => resolveMediaStatus(item.tempId, item.key));
      })
      .catch((err) => {
        if (!cancelled) setRecoveryError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [workId, disabled, resolveMediaStatus]);

  const uploadFile = useCallback(
    async (tempId, file, kind) => {
      const ext = extensionFromFilename(file.name);
      // image/ feeds the iiif-image Lambda, av/ the av-transcode one.
      const prefix = kind === "image" ? "image" : "av";
      const key = `${prefix}/${workId}/${tempId}${ext}`;
      try {
        const task = uploadData({
          path: key,
          data: file,
          options: {
            bucket: SOURCE_BUCKET_TARGET,
            // The key is a random id, so this is the only record of what the
            // file was called — the transcode copies it into media.json, which
            // is what a recovered item is labelled from. URI-encoded because
            // it travels as an x-amz-meta header, which must be ASCII.
            ...(isAvKind(kind) ? {metadata: {filename: encodeURIComponent(file.name)}} : {}),
            onProgress: ({transferredBytes, totalBytes}) => {
              if (!totalBytes) return;
              updatePending(tempId, {progress: Math.round((transferredBytes / totalBytes) * 100)});
            },
          },
        });
        uploadTasksRef.current.set(tempId, task);
        await task.result;
        uploadTasksRef.current.delete(tempId);
        updatePending(tempId, {status: "processing", key, progress: 100});
        if (kind === "image") {
          resolveImageInfo(tempId, key);
        } else {
          resolveMediaStatus(tempId, key);
        }
      } catch (err) {
        const wasCancelled = !uploadTasksRef.current.has(tempId);
        uploadTasksRef.current.delete(tempId);
        // A removed item's cancellation rejects too; it is already gone.
        if (wasCancelled) return;
        updatePending(tempId, {status: "error", errorMessage: err.message || "Upload failed"});
      }
    },
    [workId, updatePending, resolveImageInfo, resolveMediaStatus],
  );

  const handleFiles = useCallback(
    (files) => {
      const items = files
        .map((file) => ({file, kind: mediaKindFromFile(file)}))
        .filter((entry) => entry.kind)
        .map(({file, kind}) => ({
          tempId: crypto.randomUUID(),
          file,
          kind,
          key: null,
          label: assetLabelFromKey(file.name),
          status: "uploading",
          progress: 0,
          // Only an image can be previewed from the local file; A/V shows an
          // icon until the transcode hands back a poster.
          previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
          imageInfo: null,
          media: null,
          errorMessage: null,
        }));
      if (items.length === 0) return;
      setPending((prev) => [...prev, ...items]);
      items.forEach((item) => uploadFile(item.tempId, item.file, item.kind));
    },
    [uploadFile],
  );

  const handleZoneClick = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (event) => {
    handleFiles(Array.from(event.target.files || []));
    event.target.value = "";
  };

  const handleDragOver = (event) => {
    if (disabled) return;
    event.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    setDragActive(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragActive(false);
    if (disabled) return;
    handleFiles(Array.from(event.dataTransfer.files || []));
  };

  const updateLabel = (tempId, value) => {
    updatePending(tempId, {label: value});
  };

  const removePending = (tempId) => {
    const task = uploadTasksRef.current.get(tempId);
    if (task) {
      uploadTasksRef.current.delete(tempId);
      task.cancel();
    }
    setPending((prev) => {
      const item = prev.find((entry) => entry.tempId === tempId);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((entry) => entry.tempId !== tempId);
    });
  };

  // Hiding an uploaded A/V item is no longer enough: recovery would bring it
  // straight back, and its transcode would sit in the buckets for good. So
  // once it has reached the server, removing it means deleting it.
  const discardMedia = async (item) => {
    setDiscardError(null);
    try {
      await apiFetch(manifestApiUrl(`${encodeURIComponent(workId)}/media/${encodeURIComponent(item.tempId)}`), {
        method: "DELETE",
        errorMessage: "Unable to discard this upload",
      });
      removePending(item.tempId);
    } catch (err) {
      setDiscardError(err.message);
    }
  };

  const handleAttachClick = async () => {
    const ready = pending.filter((item) => item.status === "ready");
    if (ready.length === 0) return;
    setAttaching(true);
    setAttachError(null);
    try {
      const canvases = ready.map((item) =>
        item.kind === "image"
          ? buildCanvasResource(manifest, item.imageInfo, item.label)
          : buildAvCanvasResource(manifest, item.media, item.label),
      );
      await onAttach(canvases);
      const readyIds = new Set(ready.map((item) => item.tempId));
      setPending((prev) => {
        prev.filter((item) => readyIds.has(item.tempId)).forEach((item) => URL.revokeObjectURL(item.previewUrl));
        return prev.filter((item) => !readyIds.has(item.tempId));
      });
    } catch (err) {
      setAttachError(err.message || "Unable to save assets");
    } finally {
      setAttaching(false);
    }
  };

  const hasReadyItems = pending.some((item) => item.status === "ready");

  return (
    <Box className="asset-dropzone-panel">
      {/* The zone is no longer a button itself — the Upload button inside it is the
          accessible affordance, and nesting a button inside role="button" is invalid.
          Clicking the zone still opens the picker as a convenience. */}
      <Box
        className={`asset-dropzone ${dragActive ? "asset-dropzone--active" : ""} ${disabled ? "asset-dropzone--disabled" : ""}`}
        onClick={handleZoneClick}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {disabled ? (
          <Text as="p" size="2" color="gray">
            {disabledReason || "Uploads unavailable."}
          </Text>
        ) : (
          <Flex align="center" justify="center" gap="2" wrap="wrap">
            <Text as="span" size="2">
              Drag new assets here <Em>or</Em>
            </Text>
            <Button
              type="button"
              size="1"
              onClick={(event) => {
                // The zone behind this is clickable too; without this the picker
                // would be opened twice by a single click.
                event.stopPropagation();
                handleZoneClick();
              }}
            >
              <UploadIcon />
              Upload
            </Button>
          </Flex>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*,video/*"
          multiple
          className="asset-dropzone-input"
          onChange={handleFileInputChange}
          disabled={disabled}
          tabIndex={-1}
        />
      </Box>

      {recoveryError && (
        <Callout.Root color="amber" size="1" mt="2">
          <Callout.Text>{recoveryError}. Uploads from an earlier visit may not be listed.</Callout.Text>
        </Callout.Root>
      )}

      {pending.length > 0 && (
        <Flex direction="column" gap="2" className="asset-dropzone-pending">
          {pending.map((item) => {
            const thumbnailUrl = item.imageInfo
              ? buildThumbnailUrlFromInfo(item.imageInfo)
              : item.media?.poster?.url || null;
            const previewSrc = thumbnailUrl || item.previewUrl;
            return (
              <Flex key={item.tempId} align="center" gap="3" className="asset-dropzone-pending-item">
                <PendingPreview key={previewSrc || item.kind} src={previewSrc} kind={item.kind} />
                <Box className="asset-dropzone-pending-info">
                  <Text as="p" size="1" color="gray" className="asset-dropzone-filename">
                    {item.file?.name || item.filename || `Untitled ${item.kind}`}
                    {item.recovered && " · uploaded earlier"}
                  </Text>
                  {item.status === "uploading" && <Progress value={item.progress} max={100} size="1" />}
                  {(item.status === "processing" || item.status === "ready") && (
                    <TextField.Root
                      size="1"
                      value={item.label}
                      onChange={(event) => updateLabel(item.tempId, event.target.value)}
                      placeholder="Asset label"
                    />
                  )}
                  {item.status === "processing" && (
                    <Flex align="center" gap="2" mt="1">
                      <Progress size="1" duration="2s" className="asset-dropzone-processing-bar" />
                      <Text size="1" color="gray" className="asset-dropzone-processing-label">
                        {item.kind === "image" ? "Processing image…" : `Transcoding ${item.kind}… this can take a few minutes`}
                      </Text>
                    </Flex>
                  )}
                  {item.status === "error" && (
                    <Text as="p" size="1" color="red">{item.errorMessage}</Text>
                  )}
                </Box>
                {isAvKind(item.kind) && item.key ? (
                  <AlertDialog.Root>
                    <AlertDialog.Trigger>
                      <IconButton type="button" variant="soft" color="gray" size="1" aria-label="Discard">
                        <TrashIcon />
                      </IconButton>
                    </AlertDialog.Trigger>
                    <AlertDialog.Content maxWidth="calc(480 * var(--px))">
                      <AlertDialog.Title>Discard this {item.kind}?</AlertDialog.Title>
                      <AlertDialog.Description size="2">
                        This deletes the uploaded file and its transcoded versions. It has not been added to
                        the work, so nothing else is affected — but it cannot be undone.
                      </AlertDialog.Description>
                      <Flex gap="3" mt="4" justify="end">
                        <AlertDialog.Cancel>
                          <Button variant="soft" color="gray">
                            Cancel
                          </Button>
                        </AlertDialog.Cancel>
                        <AlertDialog.Action>
                          <Button color="red" onClick={() => discardMedia(item)}>
                            Discard
                          </Button>
                        </AlertDialog.Action>
                      </Flex>
                    </AlertDialog.Content>
                  </AlertDialog.Root>
                ) : (
                  <IconButton
                    type="button"
                    variant="soft"
                    color="gray"
                    size="1"
                    onClick={() => removePending(item.tempId)}
                    aria-label={item.status === "uploading" ? "Cancel upload" : "Remove"}
                  >
                    <TrashIcon />
                  </IconButton>
                )}
              </Flex>
            );
          })}
          {attachError && (
            <Callout.Root color="red" size="1">
              <Callout.Text>{attachError}</Callout.Text>
            </Callout.Root>
          )}
          {discardError && (
            <Callout.Root color="red" size="1">
              <Callout.Text>{discardError}</Callout.Text>
            </Callout.Root>
          )}
          <Flex justify="end">
            <Button type="button" onClick={handleAttachClick} loading={attaching} disabled={attaching || !hasReadyItems}>
              Add to work
            </Button>
          </Flex>
        </Flex>
      )}
    </Box>
  );
}
