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
// the three things a site needs are the same three before and after
// publishing, and showing the shape of what publishing will produce is more
// useful than an empty panel.
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

// The collection's public face: the addresses a site is pointed at. The
// actions that put them there are PublishPanel's buttons, below this one, and
// the panel's heading is PublishPanel's too: it is the button that opens it.
//
// The two steps light up independently because they are independent: a
// completed run leaves a candidate index (staged, or live once flipped), and
// only the flip makes the alias resolvable. Showing the alias before then
// hands a curator a name that 404s.
export default function ConsumesAside({status}) {
  const iiifPublished = Boolean(status?.stagedIndex || status?.liveIndex);
  const indexLive = Boolean(status?.liveIndex);

  return (
    <div className="collection-aside__panel">
      <ConsumesRow
        label="IIIF Collection"
        value={iiifPublished ? status?.consumes?.collection : null}
      />
      {/* Never a value, for now. The stack's search endpoint only answers
          requests signed by its own role, so a site handed it could not
          query anything; it comes back with the public search route. The
          row stays so the panel still shows everything a site will need. */}
      <ConsumesRow label="Amazon OpenSearch Endpoint" value={null} placeholder="Not available yet" />
      <ConsumesRow
        label="Search Index ID"
        value={indexLive ? status?.consumes?.searchAlias : null}
      />
    </div>
  );
}
