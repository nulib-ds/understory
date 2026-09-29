import {useEffect, useState} from "react";
import {Code, Heading, IconButton, Text} from "@radix-ui/themes";
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

// The collection's public face: the addresses a site is pointed at, and the
// actions that put them there.
//
// The two steps light up independently because they are independent: a
// completed run leaves a candidate index (staged, or live once flipped), and
// only the flip makes the alias resolvable. Showing the alias before then
// hands a curator a name that 404s.
export default function ConsumesAside({status, children}) {
  const iiifPublished = Boolean(status?.stagedIndex || status?.liveIndex);
  const indexLive = Boolean(status?.liveIndex);

  return (
    <div className="collection-aside__panel">
      {/* A real h3, and Radix's Heading rather than Text: Text's `as` accepts
          only span/div/p/label and silently renders anything else as a span,
          which is how a heading stops being one. The page heading is the h2,
          so a panel inside it is an h3. */}
      <Heading as="h3" size="3">
        Share &amp; publish
      </Heading>
      <ConsumesRow
        label="IIIF Collection"
        value={iiifPublished ? status?.consumes?.collection : null}
      />
      <ConsumesRow
        label="Amazon OpenSearch Endpoint"
        value={indexLive ? status?.consumes?.searchEndpoint : null}
        // A live alias with no endpoint is a misconfigured stack, not an
        // unpublished one, and says so rather than showing a dash.
        placeholder={indexLive ? "not configured" : "—"}
      />
      <ConsumesRow
        label="Search Index ID"
        value={indexLive ? status?.consumes?.searchAlias : null}
      />
      {/* The actions live inside this box, not beneath it: they are what
          produces the three values above, so the panel is one unit. */}
      {children}
    </div>
  );
}
