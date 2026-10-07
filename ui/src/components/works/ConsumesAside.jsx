import {useEffect, useState} from "react";
import {Code, IconButton, Text} from "@radix-ui/themes";
import {CheckIcon, CopyIcon} from "@radix-ui/react-icons";

// These values exist to be pasted into someone else's config, so copying them
// by hand off a wrapped line is the common case and a bad one.
//
// The clipboard API throws on an insecure origin and can be refused outright,
// so failure leaves the icon alone rather than claiming a copy that did not
// happen — the value stays selectable either way.
function CopyButton({value, label}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <IconButton
      size="1"
      variant="ghost"
      color="gray"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          // Nothing to say that the user can act on; the text is selectable.
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}

// One row. A value that does not exist yet shows a dash rather than vanishing:
// the things a site needs are the same before and after publishing, and
// showing the shape of what publishing will produce is more useful than an
// empty panel.
function ConsumesRow({label, value, placeholder = "—"}) {
  return (
    <div className="collection-aside__row">
      <Text size="1" color="gray" weight="bold">
        {label}
      </Text>
      <div className="collection-aside__value">
        {value ? (
          // ghost, not soft: soft paints a tinted block behind the value,
          // which on the panel's own grey reads as a second nested surface.
          // color="gray" because Code defaults to the accent, and the only
          // purple in this panel should be the buttons.
          <Code size="1" color="gray" variant="ghost">
            {value}
          </Code>
        ) : (
          <Text size="1" color="gray">
            {placeholder}
          </Text>
        )}
        {value && <CopyButton value={value} label={label} />}
      </div>
    </div>
  );
}

// The collection's public face: the addresses a site is pointed at. It is the
// first block in the publish dock; the actions that put them there follow it
// (PublishPanel).
//
// The two steps light up independently because they are independent: a
// completed run leaves a candidate index (staged, or live once flipped), and
// only the flip gives the search address anything to answer with. Showing it
// before then hands a curator an address that 404s.
//
// Search is one address, not an endpoint plus an index name: the public route
// takes the collection id and finds the live alias itself.
export default function ConsumesAside({status}) {
  const iiifPublished = Boolean(status?.stagedIndex || status?.liveIndex);
  const indexLive = Boolean(status?.liveIndex);

  return (
    <div className="collection-aside__panel">
      <ConsumesRow
        label="IIIF Collection"
        value={iiifPublished ? status?.consumes?.collection : null}
      />
      <ConsumesRow label="Search API" value={indexLive ? status?.consumes?.search : null} />
    </div>
  );
}
