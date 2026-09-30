// IIIF Image API request sizes, made safe for our own server.
//
// Pure, so it is unit-testable.
//
// Our Image API is 3.0 (IMAGE_API_BASE_URL ends /iiif/3). In 3.0 a request
// that would come out larger than the region is refused unless it says `^`,
// and the server we run (serverless-iiif) goes further than the spec: it also
// refuses `!w,h` whenever the BOX is larger than the image on either side,
// even when the fitted result is a downscale. Measured on our own server, on a
// 2326x2295 image:
//
//   /iiif/3/…/full/!3000,2000/…  -> 400 "Requested size requires upscaling"
//   /iiif/2/…/full/!3000,2000/…  -> 200, 2027x2000
//
// That is NUL's long-standing poster bug too (`!300,300` on a 320x240 frame).
//
// So a size copied from a source URL is never written through as-is. It is
// turned into the exact width it would have produced, capped at the region's
// own size — `{W},` — which every version accepts and which cannot trip that
// check. `max` stays `max`.

// {region}/{size}/{rotation}/{quality}.{format}, the tail of a request URL.
const IMAGE_REQUEST_PATTERN =
  /\/(full|square|pct:[\d.,]+|\d+,\d+,\d+,\d+)\/(\^?(?:max|full|pct:[\d.]+|!?\d*,\d*))\/(!?[\d.]+)\/[^/]+$/;

// The pixel size of a region of a width x height image.
function regionSize(region, {width, height}) {
  if (region === "full") return {width, height};
  if (region === "square") {
    const side = Math.min(width, height);
    return {width: side, height: side};
  }
  if (region.startsWith("pct:")) {
    const [, , w, h] = region.slice(4).split(",").map(Number);
    return {width: Math.round((width * w) / 100), height: Math.round((height * h) / 100)};
  }
  const [x, y, w, h] = region.split(",").map(Number);
  return {width: Math.max(0, Math.min(w, width - x)), height: Math.max(0, Math.min(h, height - y))};
}

// A size string -> the exact output it asks for, never larger than the
// region. `^` is dropped: nothing we write needs to upscale.
function fitSize(size, region) {
  const spec = size.replace(/^\^/, "");
  const {width, height} = region;
  if (!width || !height) return null;
  let scale;
  if (spec === "max" || spec === "full") {
    return {size: "max", width, height};
  }
  if (spec.startsWith("pct:")) {
    scale = Number(spec.slice(4)) / 100;
  } else {
    const [w, h] = spec.replace(/^!/, "").split(",").map((part) => (part === "" ? null : Number(part)));
    if (w && h) {
      // `!w,h` fits the box. A bare `w,h` asks for a distortion; for a
      // thumbnail, fitting the same box is the honest reading.
      scale = Math.min(w / width, h / height);
    } else if (w) {
      scale = w / width;
    } else if (h) {
      scale = h / height;
    } else {
      return null;
    }
  }
  scale = Math.min(1, scale);
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  return {size: outWidth === width ? "max" : `${outWidth},`, width: outWidth, height: outHeight};
}

// A source request URL, rewritten onto `serviceId` with the same region and
// rotation and a safe size. `full` is our full image's size. Returns
// {url, width, height}; width/height are null when the size cannot be known
// (a URL that is not an Image API request falls back to the whole image).
function safeImageRequest(sourceUrl, {serviceId, full}) {
  const parts = IMAGE_REQUEST_PATTERN.exec(sourceUrl || "");
  if (!parts) {
    return {url: `${serviceId}/full/max/0/default.jpg`, width: full?.width || null, height: full?.height || null};
  }
  const [, region, size, rotation] = parts;
  const fitted = full?.width && full?.height ? fitSize(size, regionSize(region, full)) : null;
  if (!fitted) {
    // Without our image's size there is nothing to fit against; `max` is the
    // one size that is always safe.
    return {url: `${serviceId}/${region}/max/${rotation}/default.jpg`, width: null, height: null};
  }
  return {
    url: `${serviceId}/${region}/${fitted.size}/${rotation}/default.jpg`,
    width: fitted.width,
    height: fitted.height,
  };
}

module.exports = {IMAGE_REQUEST_PATTERN, regionSize, fitSize, safeImageRequest};
