// Audio and video: key layout, MediaConvert job settings, and the media.json
// status document the UI polls.
//
// Pure — no AWS SDK — so all of it is unit-testable. The IO lives in
// app/aws/lambdas/av-transcode/.
//
// The layout mirrors image/: a source upload at
//
//   {source}/av/{workId}/{assetId}.{ext}
//
// is transcoded into a folder of its own in the IIIF bucket,
//
//   {iiif}/av/{workId}/{assetId}/index.m3u8   (+ renditions, segments)
//   {iiif}/av/{workId}/{assetId}/poster.*.jpg (video only)
//   {iiif}/av/{workId}/{assetId}/media.json   (status; what the UI polls)
//
// av/ sits under IIIF_BASE_URL but OUTSIDE both spaces, so the publish
// rewrite — which only touches {base}/working/… — leaves media URLs alone.
// Publishing never copies media, for the same reason it never copies a TIFF.

const AV_PREFIX = "av";

// MediaConvert decides what it can actually read; an unsupported file within
// these reaches it and comes back as a job ERROR, which media.json reports.
// These lists only decide video-versus-audio, and refuse the obviously wrong.
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "mkv", "webm", "avi", "mxf", "mpg", "mpeg", "ts", "wmv", "3gp"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "aif", "aiff", "wma"]);

const HLS_FORMAT = "application/vnd.apple.mpegurl";

function mediaKindFromExtension(ext) {
  const normalized = (ext || "").toLowerCase().replace(/^\./, "");
  if (VIDEO_EXTENSIONS.has(normalized)) return "video";
  if (AUDIO_EXTENSIONS.has(normalized)) return "audio";
  return null;
}

// workId follows sanitizeManifestIdentifier; assetId is the UI's
// crypto.randomUUID(). Anything else under av/ is not ours to transcode.
const SOURCE_KEY_PATTERN = /^av\/([A-Za-z0-9._-]+)\/([A-Za-z0-9-]+)\.([A-Za-z0-9]+)$/;

function parseSourceKey(key) {
  const match = SOURCE_KEY_PATTERN.exec(key || "");
  if (!match || match[1].includes("..")) return null;
  const [, workId, assetId, ext] = match;
  return {workId, assetId, ext: ext.toLowerCase(), kind: mediaKindFromExtension(ext)};
}

function outputPrefix(workId, assetId) {
  return `${AV_PREFIX}/${workId}/${assetId}`;
}

function mediaStatusKey(workId, assetId) {
  return `${outputPrefix(workId, assetId)}/media.json`;
}

// Automated ABR: MediaConvert picks the rendition ladder from the source and
// never upscales, so there is no ladder to maintain here. It requires QVBR
// H.264 with no width/height/bitrate on the video output, and audio in an
// output of its own, grouped by AudioGroupId.
const AUDIO_GROUP = "program_audio";

function aacAudioDescription() {
  return {
    CodecSettings: {
      Codec: "AAC",
      AacSettings: {Bitrate: 128000, CodingMode: "CODING_MODE_2_0", SampleRate: 48000},
    },
  };
}

function hlsGroup(destination, outputs, extra = {}) {
  return {
    Name: "HLS",
    OutputGroupSettings: {
      Type: "HLS_GROUP_SETTINGS",
      HlsGroupSettings: {
        Destination: destination,
        SegmentLength: 6,
        MinSegmentLength: 0,
      },
    },
    Outputs: outputs,
    ...extra,
  };
}

// `destination` is an s3:// URI for the asset's output folder, trailing slash
// omitted. The master playlist lands at {destination}/index.m3u8.
function buildJobSettings({kind, inputUri, destination}) {
  if (kind !== "video" && kind !== "audio") {
    throw new Error(`Unsupported media kind: ${kind}`);
  }
  const input = {
    FileInput: inputUri,
    TimecodeSource: "ZEROBASED",
    AudioSelectors: {"Audio Selector 1": {DefaultSelection: "DEFAULT"}},
  };
  const audioOutput = {
    NameModifier: "_audio",
    ContainerSettings: {Container: "M3U8"},
    OutputSettings: {
      HlsSettings: kind === "video"
        ? {AudioGroupId: AUDIO_GROUP, AudioTrackType: "ALTERNATE_AUDIO_AUTO_SELECT_DEFAULT"}
        : {AudioOnlyContainer: "AUTOMATIC"},
    },
    AudioDescriptions: [aacAudioDescription()],
  };

  if (kind === "audio") {
    return {
      TimecodeConfig: {Source: "ZEROBASED"},
      Inputs: [input],
      OutputGroups: [hlsGroup(`${destination}/index`, [audioOutput])],
    };
  }

  input.VideoSelector = {};
  const videoOutput = {
    NameModifier: "_video",
    ContainerSettings: {Container: "M3U8"},
    OutputSettings: {HlsSettings: {AudioRenditionSets: AUDIO_GROUP}},
    VideoDescription: {
      CodecSettings: {
        Codec: "H_264",
        // Automated ABR accepts exactly one QualityTuningLevel: MULTI_PASS_HQ.
        // Omitting it and SINGLE_PASS_HQ are both refused at submit — the first
        // two deployed video jobs found that out, one each.
        H264Settings: {
          RateControlMode: "QVBR",
          QualityTuningLevel: "MULTI_PASS_HQ",
          SceneChangeDetect: "TRANSITION_DETECTION",
        },
      },
    },
  };
  // One frame every 3s, at most two: the last one written is the poster. On a
  // clip of 3s or more that skips frame zero, which is black often enough to
  // be worth avoiding; a shorter clip still gets frame zero.
  const posterGroup = {
    Name: "Poster",
    OutputGroupSettings: {
      Type: "FILE_GROUP_SETTINGS",
      FileGroupSettings: {Destination: `${destination}/poster`},
    },
    Outputs: [
      {
        ContainerSettings: {Container: "RAW"},
        VideoDescription: {
          CodecSettings: {
            Codec: "FRAME_CAPTURE",
            FrameCaptureSettings: {FramerateNumerator: 1, FramerateDenominator: 3, MaxCaptures: 2, Quality: 80},
          },
        },
      },
    ],
  };
  return {
    TimecodeConfig: {Source: "ZEROBASED"},
    Inputs: [input],
    OutputGroups: [
      hlsGroup(`${destination}/index`, [videoOutput, audioOutput], {
        AutomatedEncodingSettings: {AbrSettings: {MaxRenditions: 5, MaxAbrBitrate: 8000000}},
      }),
      posterGroup,
    ],
  };
}

// s3://{bucket}/{key} -> {baseUrl}/{key}, or null for anything not in the
// bucket the distribution fronts.
function s3UriToPublicUrl(uri, {bucket, baseUrl}) {
  const prefix = `s3://${bucket}/`;
  if (typeof uri !== "string" || !uri.startsWith(prefix)) return null;
  return `${(baseUrl || "").replace(/\/$/, "")}/${uri.slice(prefix.length)}`;
}

// The COMPLETE event carries everything a Canvas needs — duration, the
// largest rendition's size, and the real paths MediaConvert wrote — so the
// Lambda never has to guess a filename or probe the source itself.
//
// For a frame capture output, outputFilePaths holds the LAST frame captured,
// which is exactly the poster buildJobSettings asks for.
function summarizeCompletedJob(detail, {kind, bucket, baseUrl}) {
  const groups = Array.isArray(detail?.outputGroupDetails) ? detail.outputGroupDetails : [];
  const hls = groups.find((group) => group?.type === "HLS_GROUP");
  const files = groups.find((group) => group?.type === "FILE_GROUP");
  const hlsOutputs = Array.isArray(hls?.outputDetails) ? hls.outputDetails : [];

  const streamUrl = s3UriToPublicUrl(hls?.playlistFilePaths?.[0], {bucket, baseUrl});
  if (!streamUrl) {
    throw new Error("Completed job reported no HLS playlist");
  }

  const durationMs = Math.max(0, ...hlsOutputs.map((output) => Number(output?.durationInMs) || 0));
  const summary = {
    status: "ready",
    kind,
    format: HLS_FORMAT,
    streamUrl,
    duration: Math.round(durationMs) / 1000,
  };

  if (kind === "video") {
    let largest = null;
    for (const output of hlsOutputs) {
      const width = Number(output?.videoDetails?.widthInPx) || 0;
      const height = Number(output?.videoDetails?.heightInPx) || 0;
      if (width && height && (!largest || width * height > largest.width * largest.height)) {
        largest = {width, height};
      }
    }
    if (largest) {
      summary.width = largest.width;
      summary.height = largest.height;
    }
    const posterOutput = files?.outputDetails?.[0];
    const posterUrl = s3UriToPublicUrl(posterOutput?.outputFilePaths?.[0], {bucket, baseUrl});
    if (posterUrl) {
      summary.poster = {
        url: posterUrl,
        width: Number(posterOutput?.videoDetails?.widthInPx) || summary.width,
        height: Number(posterOutput?.videoDetails?.heightInPx) || summary.height,
      };
    }
  }
  return summary;
}

// --- Recovery ---------------------------------------------------------------
//
// A pending upload used to live only in the dropzone's React state, so leaving
// the page orphaned it: the transcode still ran and was paid for, and nothing
// could find it again. It turns out nothing needs to be remembered — the
// source listing says what was uploaded, media.json says how far each got, and
// the manifest says which are already attached. Recovery is the difference.

// The assetIds this manifest's canvases already play, read off their painting
// bodies ({base}/av/{workId}/{assetId}/…). A removed canvas drops out of this
// set, so its media comes back as "ready to add" rather than vanishing — which
// is what makes the discard route necessary.
function attachedAssetIds(manifest, workId) {
  const marker = `/${AV_PREFIX}/${workId}/`;
  const found = new Set();
  for (const canvas of Array.isArray(manifest?.items) ? manifest.items : []) {
    for (const page of canvas?.items || []) {
      for (const annotation of page?.items || []) {
        const id = annotation?.body?.id;
        const at = typeof id === "string" ? id.indexOf(marker) : -1;
        if (at === -1) continue;
        const assetId = id.slice(at + marker.length).split("/")[0];
        if (assetId) found.add(assetId);
      }
    }
  }
  return found;
}

// How long an upload may sit with no media.json before it is reported as
// stuck. The Lambda writes "processing" within seconds of the upload
// completing; a quarter of an hour without it means that invocation died.
const STATUS_MISSING_AFTER_MS = 15 * 60 * 1000;

// `uploads` is the source listing, [{key, lastModified}]; `statusFor(assetId)`
// is that asset's media.json, or null. Only assets NOT attached are returned,
// newest first, each with a status the UI can render directly.
function unattachedMedia({uploads, workId, manifest, statuses, now = Date.now()}) {
  const attached = attachedAssetIds(manifest, workId);
  const results = [];
  for (const upload of uploads || []) {
    const parsed = parseSourceKey(upload?.key);
    if (!parsed || parsed.workId !== workId || attached.has(parsed.assetId)) continue;
    const uploadedAt = upload.lastModified ? new Date(upload.lastModified).getTime() : null;
    let status = statuses?.get(parsed.assetId) || null;
    if (!status) {
      const stuck = uploadedAt !== null && now - uploadedAt > STATUS_MISSING_AFTER_MS;
      status = stuck
        ? {status: "error", kind: parsed.kind, error: "Transcoding never started — discard and upload again"}
        : {status: "processing", kind: parsed.kind};
    }
    results.push({
      assetId: parsed.assetId,
      key: upload.key,
      kind: status.kind || parsed.kind,
      uploadedAt: uploadedAt ? new Date(uploadedAt).toISOString() : null,
      media: status,
    });
  }
  return results.sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
}

// Assets are named by the UI's crypto.randomUUID(); nothing else is a valid
// discard target, and the pattern keeps a path segment out of an S3 prefix.
const ASSET_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function isAssetId(value) {
  return typeof value === "string" && ASSET_ID_PATTERN.test(value);
}

module.exports = {
  AV_PREFIX,
  HLS_FORMAT,
  mediaKindFromExtension,
  parseSourceKey,
  outputPrefix,
  mediaStatusKey,
  buildJobSettings,
  s3UriToPublicUrl,
  summarizeCompletedJob,
  attachedAssetIds,
  unattachedMedia,
  isAssetId,
  STATUS_MISSING_AFTER_MS,
};
