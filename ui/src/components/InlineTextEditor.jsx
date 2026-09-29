import {useCallback, useEffect, useMemo, useState} from "react";
import {Flex, IconButton, Text, TextArea, TextField, Tooltip} from "@radix-ui/themes";
import {CheckIcon, TrashIcon} from "@radix-ui/react-icons";
import {renderIiifHtml} from "../lib/iiifHtml";

// Only one editor is open at a time, across the whole page: opening one closes
// whichever was open, discarding its draft exactly as Escape would. Several
// open at once — a column of fields, each with its own check button — gave
// no way to tell which one Enter would save. Module state rather than a
// context, because every editor on a page needs it and none of them should
// have to be wrapped for it.
let closeOpenEditor = null;

// Click the text to edit it in place; Check (or Enter) saves and reverts to plain
// text, Escape cancels. Used for canvas labels and every manifest metadata field.
//   multiline  — a TextArea, where Enter inserts a newline and only Check saves.
//   allowEmpty — permit clearing the value (a description can be removed; a
//                canvas label cannot, so it keeps the default guard).
//   html       — the value may be IIIF HTML (summary, metadata values; never
//                a label). Valid HTML renders as HTML while viewing and shows
//                as its raw markup once clicked into; anything that fails
//                §4.5's rules stays plain text. See lib/iiifHtml.js.
//   onRemove   — offer a remove button, shown ONLY while editing, beside the
//                field. Removing is then something you do to the value you
//                have open, rather than a column of trash cans that looked
//                like the delete for the whole row. Omit it where the value
//                cannot be removed (a field's last value).
export default function InlineTextEditor({
  value: savedValue,
  onSave,
  multiline = false,
  allowEmpty = false,
  placeholder = "Not set",
  as = "p",
  textProps = {weight: "bold", size: "2"},
  fieldSize = "1",
  ariaLabel = "Edit value",
  className = "",
  onRemove,
  removeLabel = "Remove",
  html = false,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(savedValue);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(null);
  const rendered = useMemo(
    () => (html && savedValue ? renderIiifHtml(savedValue) : null),
    [html, savedValue],
  );

  useEffect(() => {
    if (!editing) setDraft(savedValue);
  }, [savedValue, editing]);

  const startEditing = () => {
    setError(null);
    setDraft(savedValue);
    setEditing(true);
  };

  // Stable, so the currently open editor can be recognised by identity.
  const close = useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!editing) return undefined;
    if (closeOpenEditor && closeOpenEditor !== close) closeOpenEditor();
    closeOpenEditor = close;
    return () => {
      if (closeOpenEditor === close) closeOpenEditor = null;
    };
  }, [editing, close]);

  const cancelEditing = () => {
    setEditing(false);
    setDraft(savedValue);
    setError(null);
  };

  const handleSave = async () => {
    const trimmed = draft.trim();
    if ((!trimmed && !allowEmpty) || trimmed === savedValue) {
      cancelEditing();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // On success the caller's list re-renders without this value, which usually
  // unmounts this editor. Closing anyway covers the case where it does not
  // (the next value is identical, so it keeps this one's key).
  const handleRemove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await onRemove();
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setRemoving(false);
    }
  };

  if (!editing) {
    return (
      <Text
        // A div when it holds rendered HTML: the markup may contain <p>, and a
        // <p> inside the default <p> is invalid nesting.
        as={rendered ? "div" : as}
        {...textProps}
        color={savedValue ? textProps.color : "gray"}
        role="button"
        tabIndex={0}
        className={`canvas-label-editable ${rendered ? "iiif-html" : ""} ${className}`.trim()}
        // A link inside rendered HTML is followed, not treated as a click to
        // edit — by mouse or by Enter on the focused link.
        onClick={(event) => {
          if (event.target.closest("a")) return;
          startEditing();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            startEditing();
          }
        }}
      >
        {rendered ?? (savedValue || placeholder)}
      </Text>
    );
  }

  const onKeyDown = (event) => {
    // In a TextArea Enter has to stay a newline, so Check is the only way to save.
    if (event.key === "Enter" && !multiline) handleSave();
    if (event.key === "Escape") cancelEditing();
  };

  return (
    <Flex direction="column" gap="1">
      <Flex align={multiline ? "end" : "center"} gap="1">
        {multiline ? (
          <TextArea
            size={fieldSize}
            value={draft}
            autoFocus
            disabled={saving}
            rows={3}
            style={{flex: 1}}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <TextField.Root
            size={fieldSize}
            value={draft}
            style={{flex: 1}}
            autoFocus
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        <IconButton
          size={fieldSize}
          variant="soft"
          onClick={handleSave}
          loading={saving}
          disabled={removing}
          aria-label={ariaLabel}
        >
          <CheckIcon />
        </IconButton>
        {onRemove && (
          <Tooltip content={removeLabel}>
            <IconButton
              size={fieldSize}
              variant="soft"
              color="red"
              onClick={handleRemove}
              loading={removing}
              disabled={saving}
              aria-label={removeLabel}
            >
              <TrashIcon />
            </IconButton>
          </Tooltip>
        )}
      </Flex>
      {error && <Text as="p" size="1" color="red">{error}</Text>}
    </Flex>
  );
}
