import {createElement} from "react";

// HTML in IIIF property values, per Presentation 3.0 §4.5:
// https://iiif.io/api/presentation/3.0/#45-html-markup-in-property-values
//
// Only `summary` and the `value` of metadata / requiredStatement entries may
// carry it — never a label. A value is HTML only if its first character is
// "<" and its last is ">" (no whitespace outside them) AND it is well-formed
// XML, which means one wrapping element such as <p> or <span>. Anything else
// is plain text that happens to contain angle brackets, and is shown as such.
//
// The output is built as React elements from a whitelist, never through
// innerHTML: nothing the checks below did not explicitly let through can
// reach the page, however the input is constructed.

// The only tags §4.5 lets a client render.
const ALLOWED_TAGS = new Set(["a", "b", "br", "i", "img", "p", "small", "span", "sub", "sup"]);
const VOID_TAGS = new Set(["br", "img"]);
// §4.5: clients MUST remove "tags such as script, style, object, form, input
// and similar". Removed together with their content, which is code or form
// state rather than text. Any other disallowed tag (em, strong, ul…) is
// unwrapped instead, so its text survives.
const REMOVED_WITH_CONTENT = new Set([
  "script", "style", "object", "embed", "applet", "iframe", "frame", "frameset",
  "form", "input", "button", "select", "option", "textarea", "template",
  "noscript", "link", "meta", "base", "svg", "math", "audio", "video", "canvas",
]);
// §4.5 names these for href. src gets the web schemes only: an image from
// anywhere else (data:, file:, javascript:) is not something a published
// manifest should be pointing a viewer at.
const HREF_SCHEME = /^(https?:|mailto:)/i;
const SRC_SCHEME = /^https?:/i;

// A deliberate exception to §4.5's well-formed-XML rule: an <a> whose href is
// not quoted, as in
//
//   <span><a href=https://example.org/c.php?g=1&p=2>Guide</a></span>
//
// which real sources publish (every Fava work carries one, imported from
// NUL). An HTML parser would accept it; an XML one refuses both the missing
// quotes and the bare "&" that such a URL almost always contains. So an
// unquoted href is read the way a browser would: as a literal URL running to
// the next space or ">", quoted, with its "&" escaped unless it already starts
// an entity.
//
// Only for parsing. The stored value is never touched — it is still what the
// editor shows when clicked into, and still what a stricter client sees — and
// nothing else about well-formedness is relaxed.
const UNQUOTED_HREF = /(<a\b[^>]*?\s)href=([^\s"'<>]+)/gi;
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi;

function quoteUnquotedHrefs(value) {
  return value.replace(UNQUOTED_HREF, (_, before, url) =>
    `${before}href="${url.replace(BARE_AMPERSAND, "&amp;")}"`,
  );
}

export function looksLikeIiifHtml(value) {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value[0] === "<" &&
    value[value.length - 1] === ">"
  );
}

// The value as a sanitized tree ({tag, attrs, children}, with strings for
// text), or null when it is not HTML by §4.5's rules. Plain data, so it can be
// inspected without rendering anything.
export function sanitizeIiifHtml(value) {
  if (!looksLikeIiifHtml(value)) return null;
  // DOMParser is a browser API. Where there is none (a server render), the
  // value is shown as the plain text it also is, rather than failing.
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(quoteUnquotedHrefs(value), "application/xml");
  // Both Chrome and Firefox report a failed parse as a <parsererror> element
  // rather than by throwing.
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const tree = sanitizeNode(doc.documentElement);
  // A value that sanitizes to nothing (a lone <script>, say) is shown as the
  // markup it is. An editor should not display a value as blank.
  return tree && typeof tree === "object" ? tree : null;
}

const IIIF_RULES = {tags: ALLOWED_TAGS, href: HREF_SCHEME, src: SRC_SCHEME, extraAttrs: []};

function sanitizeNode(node, rules = IIIF_RULES) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  // CDATA sections, comments and processing instructions: §4.5 says remove.
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const tag = node.localName.toLowerCase();
  if (REMOVED_WITH_CONTENT.has(tag)) return null;
  const children = [...node.childNodes]
    .map((child) => sanitizeNode(child, rules))
    .filter((child) => child !== null);
  if (!rules.tags.has(tag)) return {tag: null, attrs: {}, children};

  // Every attribute is dropped except these three, and those only when safe.
  const attrs = {};
  if (tag === "a") {
    const href = node.getAttribute("href");
    if (href && rules.href.test(href)) attrs.href = href;
  }
  if (tag === "img") {
    const src = node.getAttribute("src");
    if (!src || !rules.src.test(src)) return null;
    attrs.src = src;
    attrs.alt = node.getAttribute("alt") ?? "";
  }
  // Plain text attributes, for snippets only: none of them can carry a URL or
  // run anything. `class` becomes React's className.
  for (const name of rules.extraAttrs) {
    const value = node.getAttribute(name);
    if (value) attrs[name === "class" ? "className" : name] = value;
  }
  return {tag, attrs, children: VOID_TAGS.has(tag) ? [] : children};
}

// React elements for a value, or null when it should be shown as plain text.
export function renderIiifHtml(value) {
  const tree = sanitizeIiifHtml(value);
  return tree ? toElement(tree, "root") : null;
}

function toElement(node, key) {
  if (typeof node === "string") return node;
  const children = node.children.map((child, index) => toElement(child, index));
  // An unwrapped tag contributes only its children.
  if (!node.tag) return children;
  const props = {key, ...node.attrs};
  // Links open in a new tab: this is an editor, and following one in place
  // would leave the page with whatever was being worked on.
  if (node.tag === "a" && props.href) {
    props.target = "_blank";
    props.rel = "noopener noreferrer";
  }
  return VOID_TAGS.has(node.tag)
    ? createElement(node.tag, props)
    : createElement(node.tag, props, children);
}

// --- Branding snippets ------------------------------------------------------
//
// An instance's branding folder can carry small HTML snippets (header.html,
// footer.html, sign-in.html). They are the instance owner's own markup, but
// they get the same treatment as IIIF HTML: React elements from a whitelist,
// never innerHTML, so a snippet can lay out text, links and images and can
// never run script.
//
// Three differences from IIIF values, all because a snippet is a file someone
// writes by hand rather than a property value:
//   - parsed as HTML, not XML, so <img ...> without a closing slash is fine and
//     a snippet may have several top-level elements;
//   - a few more layout tags, and class / title / aria-label on any of them;
//   - links and images may be root-relative ("/branding/assets/logo.svg"), so a
//     snippet can point at its own folder.
const SNIPPET_RULES = {
  tags: new Set([...ALLOWED_TAGS, "div", "strong", "em", "ul", "ol", "li"]),
  href: /^(https?:|mailto:|\/(?!\/))/i,
  src: /^(https?:|\/(?!\/))/i,
  extraAttrs: ["class", "title", "aria-label"],
};

export function renderSnippetHtml(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(value, "text/html");
  const nodes = [...doc.body.childNodes]
    .map((node) => sanitizeNode(node, SNIPPET_RULES))
    .filter((node) => node !== null);
  return nodes.length ? nodes.map((node, index) => toElement(node, index)) : null;
}
