const fs = require("fs");
const os = require("os");
const path = require("path");
const {pipeline} = require("stream/promises");
const {S3Client, GetObjectCommand} = require("@aws-sdk/client-s3");
const {Upload} = require("@aws-sdk/lib-storage");
const sharp = require("sharp");

// libvips' operation cache can hold an open handle on a file this function has
// already deleted, which keeps its space in /tmp for the life of the container.
sharp.cache(false);

const s3 = new S3Client({});
const IIIF_BUCKET = process.env.IIIF_BUCKET;
const SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".tif", ".tiff", ".png", ".webp"]);

exports.handler = async (event) => {
  for (const record of event.Records) {
    const sourceBucket = record.s3.bucket.name;
    const sourceKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    console.log(`Processing s3://${sourceBucket}/${sourceKey}`);

    const ext = sourceKey.slice(sourceKey.lastIndexOf(".")).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      console.log(`Skipping ${sourceKey} (unsupported type)`);
      continue;
    }

    const parts = sourceKey.split("/");
    const filename = parts.pop();
    const identifier = filename.replace(/\.[^.]+$/, "");
    const outputKey = [...parts, `${identifier}.tif`].join("/");

    // File to file through /tmp, never buffer to buffer. A buffer holds the
    // decoded image and the whole pyramid at once: a 184-megapixel map peaked
    // at 1019MB of this function's 1025MB. From a file, libvips streams the
    // image through in strips (about a quarter of the memory for that map), so
    // memory no longer grows with the image. Disk does, hence EphemeralStorage.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "iiif-image-"));
    try {
      const sourcePath = path.join(workDir, `source${ext}`);
      const pyramidPath = path.join(workDir, "pyramid.tif");

      const {Body} = await s3.send(new GetObjectCommand({Bucket: sourceBucket, Key: sourceKey}));
      await pipeline(Body, fs.createWriteStream(sourcePath));

      // serverless-iiif streams the WHOLE TIFF from S3 for every request, a
      // 256px tile included, so the file's size is paid on every tile. JPEG
      // is what its docs recommend: the 184MP map is 56MB, where LZW was 404MB
      // and timed serverless-iiif out. Two things to keep:
      // - no alpha channel, which a JPEG-compressed TIFF cannot carry, so a
      //   transparent PNG/WebP is laid on white;
      // - quality below 90. At 90 and up libvips stops writing YCbCr: with
      //   this sharp (0.33) the colours come out wrong (red read back teal,
      //   by libtiff too), and with 0.35, which fixes that, the map is 197MB.
      await sharp(sourcePath)
        .flatten({background: "#ffffff"})
        .tiff({
          tile: true,
          tileWidth: 256,
          tileHeight: 256,
          pyramid: true,
          compression: "jpeg",
          quality: 85,
        })
        .toFile(pyramidPath);

      // serverless-iiif reads width and height from the object's metadata
      // when they are there, and otherwise probes the image itself: another
      // full download, on every request. pages names the pyramid's levels.
      const {width, height, pages} = await sharp(pyramidPath).metadata();

      await new Upload({
        client: s3,
        params: {
          Bucket: IIIF_BUCKET,
          Key: outputKey,
          Body: fs.createReadStream(pyramidPath),
          ContentType: "image/tiff",
          Metadata: {width: String(width), height: String(height), pages: String(pages)},
        },
      }).done();
    } finally {
      // /tmp outlives the invocation in a warm container.
      fs.rmSync(workDir, {recursive: true, force: true});
    }

    console.log(`Done: s3://${IIIF_BUCKET}/${outputKey}`);
  }
};
