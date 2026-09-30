import {imageRequestUrl} from "../lib/canvasAssets";
import "./AssetThumbnails.css";

const ITEM_REM = 1.5; // matches .asset-thumbnails__item's fixed width/height
const STACK_OVERLAP_REM = 0.55; // constant overlap between every pair of stacked items

function iiifThumbnailUrl(serviceId, size) {
  return imageRequestUrl(serviceId, {size: `,${size}`});
}

function hideOnError(event) {
  event.currentTarget.style.display = "none";
}

// Stacked layout: every item overlaps the previous one by the same fixed
// amount, front-to-back z-index so the first item always reads as the top.
function stackStyle(index, count) {
  if (index === 0) {
    return {zIndex: count};
  }
  return {
    zIndex: count - index,
    marginLeft: `${-STACK_OVERLAP_REM}rem`,
    "--stack-collapse-x": `${-(index * (ITEM_REM - STACK_OVERLAP_REM))}rem`,
  };
}

export default function AssetThumbnails({services, size = 32, max, count, stacked = false, className}) {
  if (!Array.isArray(services) || services.length === 0) {
    return null;
  }

  const visible = typeof max === "number" ? services.slice(0, max) : services;
  const badgeCount = typeof count === "number" ? count : services.length;

  return (
    <div className={`asset-thumbnails-group ${className || ""}`}>
      <div className={`asset-thumbnails ${stacked ? "asset-thumbnails--stacked" : ""}`}>
        {visible.map((serviceId, index) => (
          <img
            key={`${serviceId}-${index}`}
            className="asset-thumbnails__item"
            src={iiifThumbnailUrl(serviceId, size)}
            alt=""
            loading="lazy"
            onError={hideOnError}
            style={stacked ? stackStyle(index, visible.length) : undefined}
          />
        ))}
      </div>
      {stacked && badgeCount > 0 && (
        <span className="asset-thumbnails__badge">{badgeCount}</span>
      )}
    </div>
  );
}
