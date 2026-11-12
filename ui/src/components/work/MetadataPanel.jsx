import {useState} from "react";
import {Box, Button, Card, Code, Flex, Text, Tooltip} from "@radix-ui/themes";
import {InfoCircledIcon, PlusIcon, TrashIcon} from "@radix-ui/react-icons";
// TrashIcon is the card's Remove field only, and it asks first
// (ConfirmIconButton). Nothing inside a card deletes:
// clearing a value takes it out of its language, and a language left with no
// values is written as `[]` (writeLanguageValues), for publishing to drop.
import InlineTextEditor from "../InlineTextEditor";
import ConfirmIconButton from "../ConfirmIconButton";
import {AddLanguageButton, Lane, MapLanes} from "./LanguageLanes";
import {renderIiifHtml} from "../../lib/iiifHtml";
import {
  NONE,
  langAttribute,
  languageAutonym,
  resolveLanguageMap,
  setLanguageValue,
} from "../../lib/languageMap";
import {useLanguageLanes, useLanguagePreferences} from "../../lib/workLanguage";

// A work's descriptive properties as cards, one per field, with a lane in each
// card for every language that is turned on. Three groups, kept apart because
// they are three different things in the Presentation API, each named by its
// property: the work's own `label` and `summary`; its `metadata`, a list of
// field-and-value pairs; and its `requiredStatement`, at the bottom.
//
// Each card shows, lane by lane, what the manifest stores under that language's
// key, so the language is said once, by the lane, rather than beside every value.
//
// Which lanes exist: the collection's languages, in its order of preference
// (GET /collections/{slug}/languages), then any other language the work itself
// uses, then None for text with no language (useLanguageLanes,
// lib/workLanguage.js). The chips beside the page's section control turn lanes
// on and off (LanguageChips); that choice is the viewer's alone and changes
// nothing stored. Each value is edited where it is stored (lib/languageMap.js), so
// editing the French leaves the English as it was, and nothing is ever moved
// from one language to another.

const arrayAt = (map, code) => (Array.isArray(map?.[code]) ? map[code] : []);

// Whether a metadata entry holds any text: a name or a value, in any language.
const mapHasText = (map) =>
  Object.values(map || {}).some(
    (values) => Array.isArray(values) && values.some((value) => typeof value === "string" && value.trim()),
  );
const hasContent = (entry) => mapHasText(entry?.label) || mapHasText(entry?.value);

// An entry with a key in both of its maps, as the API requires of a language
// map: an empty array under `code` for a map that has none.
const hasKey = (map) => Boolean(map) && typeof map === "object" && Object.keys(map).length > 0;
const withKeys = (entry, code) => ({
  ...entry,
  label: hasKey(entry.label) ? entry.label : {[code]: []},
  value: hasKey(entry.value) ? entry.value : {[code]: []},
});

// A group of cards, under a heading that names the property they belong to.
function FieldSection({title, property, children}) {
  return (
    <section className="field-section">
      {/* A step above the cards' own titles (size 3, bold), so the three
          groups read as the tab's outline. */}
      <Flex align="baseline" gap="2" mb="3">
        <Text asChild size="5" weight="bold">
          <h3>{title}</h3>
        </Text>
        {property && (
          <Code size="4" variant="ghost" color="gray">
            {property}
          </Code>
        )}
      </Flex>
      <div className="field-cards">{children}</div>
    </section>
  );
}

// One field's card: a lane per language, and nothing above them. The section
// it sits in names the property (`label`, `summary`, `metadata`,
// `requiredStatement`), and a field's own name is its `label`, which each lane
// already shows in that lane's language, so a heading would only repeat one of
// them. The card is still named for assistive technology (`ariaLabel`).
//
// `action` (a metadata field's Remove field) floats in the top-right corner,
// over the first lane, rather than in a row of its own.
function FieldCard({ariaLabel, action, children}) {
  return (
    <Card size="2" className="field-card" role="group" aria-label={ariaLabel}>
      {action && <div className="field-card__corner">{action}</div>}
      <div className="field-card__lanes">{children}</div>
    </Card>
  );
}


export default function MetadataPanel({
  manifest,
  onSaveTitle,
  onSaveSummary,
  onSaveMetadata,
}) {
  const preferences = useLanguagePreferences();
  const {visible, preferred, collectionLanguages} = useLanguageLanes();
  const entries = Array.isArray(manifest?.metadata) ? manifest.metadata : [];
  // The one lane a curator has asked to add a value in ("Add Français"), as
  // `${field}:${code}`. Its editors show until something is saved there.
  const [adding, setAdding] = useState(null);
  const isAdding = (field, code) => adding === `${field}:${code}`;

  // An entry with no name and no value, in any language, is never written: the
  // save leaves it out, so clearing the last of a field's text takes the field
  // away with it, and a field Add field opened is not written until something
  // is typed in it (the draft, below). What is written keeps a key in each of
  // its language maps, since a map needs one: [] under the preferred language
  // (or None) where it has none.
  const saveEntries = (next) => {
    const kept = next.filter(hasContent).map((entry) => withKeys(entry, preferred || NONE));
    return onSaveMetadata(kept.length ? kept : null);
  };
  const updateEntry = (index, mutate) =>
    saveEntries(entries.map((entry, i) => (i === index ? mutate(entry) : entry)));

  // Add field's card: held here, unwritten, until its first name or value is
  // saved, which writes it as a new entry at the end.
  const [draft, setDraft] = useState(null);
  const updateDraft = async (mutate) => {
    const next = mutate(draft || {});
    if (!hasContent(next)) {
      setDraft(next);
      return;
    }
    await saveEntries([...entries, next]);
    setDraft(null);
  };

  const statement = manifest?.requiredStatement;

  // One metadata field's card. The same for a stored entry and for the draft
  // Add field opens: `update` saves a change to it, `onRemove` takes it away.
  const renderField = (entry, {key, field, update, onRemove}) => {
              const heading = resolveLanguageMap(entry.label, preferences);
                return (
                <FieldCard
                  key={key}
                  ariaLabel={heading.values[0] || "New field"}
                  action={
                    <ConfirmIconButton
                      label="Remove field"
                      icon={<TrashIcon />}
                      color="red"
                      onConfirm={onRemove}
                    />
                  }
                >
                  {visible.map((code) => {
                    const names = arrayAt(entry.label, code);
                    const values = arrayAt(entry.value, code);
                    const autonym = languageAutonym(code);
                    const adding = isAdding(field, code);
                    if (!names.length && !values.length && !adding) {
                      return (
                        <Lane key={code} code={code}>
                          <AddLanguageButton code={code} onClick={() => setAdding(`${field}:${code}`)} />
                        </Lane>
                      );
                    }
                    return (
                      <Lane key={code} code={code}>
                        {/* A field named in its languages but with values in
                            None is the common shape (a date, a name), so the None
                            lane asks for no name of its own. */}
                        {(code !== NONE || names.length > 0) && (
                        <InlineTextEditor
                          value={names[0] || ""}
                          lang={langAttribute(code)}
                          onSave={async (next) => {
                            await update((e) => ({
                              ...e,
                              label: setLanguageValue(e.label, code, 0, next || null),
                            }));
                          }}
                          // Cleared, the name in this language is written as [].
                          allowEmpty
                          clearable
                          clearLabel="Clear name"
                          ariaLabel="Save field name"
                          placeholder={`Field name in ${autonym}`}
                          // Muted (.field-lane__name): the name labels the values
                          // under it, which are what the lane is for.
                          textProps={{size: "2"}}
                          className="field-lane__name"
                          fieldSize="2"
                        />
                        )}
                        {values.map((value, valueIndex) => (
                          /* Keyed on the value as well as its place: removing one
                             shifts every value after it up an index, and a
                             place-only key would hand the open editor — still in
                             edit mode — to the value that moved into it. */
                          <Box key={`${valueIndex}:${value}`} className="metadata-value">
                            <InlineTextEditor
                              value={value}
                              lang={langAttribute(code)}
                              // Clearing a value takes it out of this language,
                              // which stays as [] when it was the last.
                              onSave={(next) =>
                                update((e) => ({
                                  ...e,
                                  value: setLanguageValue(e.value, code, valueIndex, next || null),
                                }))
                              }
                              allowEmpty
                              clearable
                              ariaLabel="Save value"
                              // Values may be HTML; field names (labels) may not.
                              html
                              textProps={{size: "3"}}
                              fieldSize="2"
                            />
                          </Box>
                        ))}
                        {/* "Add value" opens an empty editor; only what is typed into it is
                            written. Nothing stands in for a value that was never given. */}
                        {adding ? (
                          <Box className="metadata-value">
                            <InlineTextEditor
                              value=""
                              autoEdit
                              lang={langAttribute(code)}
                              onSave={async (next) => {
                                if (!next) return;
                                await update((e) => ({
                                  ...e,
                                  value: setLanguageValue(e.value, code, Number.POSITIVE_INFINITY, next),
                                }));
                                setAdding(null);
                              }}
                              ariaLabel="Save value"
                              placeholder={`Value in ${autonym}`}
                              html
                              textProps={{size: "3"}}
                              fieldSize="2"
                            />
                          </Box>
                        ) : (
                          <Flex align="center" gap="3">
                            <Button
                              type="button"
                              variant="ghost"
                              size="2"
                              onClick={() => setAdding(`${field}:${code}`)}
                            >
                              <PlusIcon /> Add value
                            </Button>
                            {/* What a reader in this language sees while it has no
                                values of its own: the field's None values, by the
                                spec's algorithm. A tooltip on an accent mark rather
                                than a line of text; focusable, so it is not for the
                                mouse alone. */}
                            {values.length === 0 && code !== NONE && arrayAt(entry.value, NONE).length > 0 && (
                              <Tooltip content="Shows the None value">
                                <span
                                  className="field-lane__fallback"
                                  tabIndex={0}
                                  role="img"
                                  aria-label="Shows the None value"
                                >
                                  <InfoCircledIcon />
                                </span>
                              </Tooltip>
                            )}
                          </Flex>
                        )}
                      </Lane>
                    );
                  })}
                </FieldCard>
              );
  };



  return (
    <Flex direction="column" gap="4" className="metadata-panel">
      {collectionLanguages.length === 0 && (
        <Text as="p" size="2" color="gray">
          This collection has no languages set, so the lanes follow what this work uses. Set
          them, and their order, on the collection&rsquo;s Languages tab.
        </Text>
      )}
      {visible.length === 0 ? (
        <Text as="p" size="3" color="gray">
          Turn on a language to see its values.
        </Text>
      ) : (
        <div className="metadata-fields">
          <FieldSection title="Title" property="label">
            <FieldCard ariaLabel="Title">
              {/* A work keeps at least one title, so its last cannot be cleared. */}
              <MapLanes map={manifest?.label} visible={visible} onSave={onSaveTitle} noun="Title" keepOne />
            </FieldCard>
          </FieldSection>

          <FieldSection title="Description" property="summary">
            <FieldCard ariaLabel="Description">
              <MapLanes
                map={manifest?.summary}
                visible={visible}
                onSave={onSaveSummary}
                noun="Description"
                multiline
                html
              />
            </FieldCard>
          </FieldSection>

          <FieldSection title="Metadata" property="metadata">
            {entries.length === 0 && (
              <Text as="p" size="3" color="gray">
                No metadata fields.
              </Text>
            )}
            {entries.map((entry, index) =>
              renderField(entry, {
                key: index,
                field: `metadata-${index}`,
                update: (mutate) => updateEntry(index, mutate),
                onRemove: () => saveEntries(entries.filter((_, i) => i !== index)),
              }),
            )}
            {/* Add field's card, before anything is typed in it: in the page
                only, until its first name or value is saved. */}
            {draft &&
              renderField(draft, {
                key: "draft",
                field: "metadata-draft",
                update: updateDraft,
                onRemove: async () => setDraft(null),
              })}
            <Box>
              <Button
                type="button"
                variant="soft"
                size="2"
                // Opens a draft card; nothing is written until it has text.
                onClick={() => setDraft((current) => current || {})}
              >
                <PlusIcon /> Add field
              </Button>
            </Box>
          </FieldSection>

          {/* Shown, not edited: the API does not take a requiredStatement. */}
          {statement?.value && (
            <FieldSection title="Required statement" property="requiredStatement">
              <FieldCard
                ariaLabel={resolveLanguageMap(statement.label, preferences).values[0] || "Required statement"}
              >
                {visible.map((code) => {
                  const names = arrayAt(statement.label, code);
                  const values = arrayAt(statement.value, code);
                  return (
                    <Lane key={code} code={code}>
                      {names.length === 0 && values.length === 0 ? (
                        <Text size="2" color="gray">
                          Nothing in <span lang={langAttribute(code)}>{languageAutonym(code)}</span>
                        </Text>
                      ) : (
                        <>
                          {names[0] && (
                            <Text as="p" size="2" weight="medium" color="gray" lang={langAttribute(code)}>
                              {names[0]}
                            </Text>
                          )}
                          {values.map((value, i) => (
                            <Text key={i} as="div" size="3" className="iiif-html" lang={langAttribute(code)}>
                              {renderIiifHtml(value) ?? value}
                            </Text>
                          ))}
                        </>
                      )}
                    </Lane>
                  );
                })}
              </FieldCard>
            </FieldSection>
          )}
        </div>
      )}

    </Flex>
  );
}
