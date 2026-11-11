import {useState} from "react";
import {Box, Button, Text} from "@radix-ui/themes";
import {PlusIcon} from "@radix-ui/react-icons";
import InlineTextEditor from "../InlineTextEditor";
import {langAttribute, languageAutonym, setLanguageValue} from "../../lib/languageMap";

// The language lanes a work's text is shown and edited in, shared by the
// Metadata tab (MetadataPanel) and the Assets tab's canvas labels
// (SortableCanvasCard). A lane shows exactly what the manifest stores under one
// language's key; which lanes are shown is the page's choice (useLanguageLanes,
// lib/workLanguage.js), made with the chips beside the section control.

const arrayAt = (map, code) => (Array.isArray(map?.[code]) ? map[code] : []);
const countValues = (map) =>
  Object.values(map || {}).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0);

// One language's lane: its code, muted (the chips name each language in full),
// then whatever the lane holds.
export function Lane({code, children}) {
  return (
    <div className="field-lane">
      <div className="field-lane__language">
        <Text size="2" color="gray" className="field-lane__code">
          {code}
        </Text>
      </div>
      <div className="field-lane__values">{children}</div>
    </div>
  );
}

// What an empty lane offers: "Add Français", "Add None".
export function AddLanguageButton({code, onClick}) {
  return (
    <Box>
      <Button type="button" variant="ghost" size="2" onClick={onClick}>
        <PlusIcon /> Add <span lang={langAttribute(code)}>{languageAutonym(code)}</span>
      </Button>
    </Box>
  );
}

// A whole language map as lanes, every value its own editor: a work's title or
// description, a canvas's label. `onSave` receives the whole new map, built so
// that only the one value edited changes and an emptied language stays as `[]`
// (lib/languageMap.js).
//
//   noun       — what a value is, for placeholders and labels ("Title").
//   keepOne    — the map must keep at least one value somewhere, so its last
//                one cannot be cleared (a work's title).
//   multiline, html, textProps — as InlineTextEditor's.
export function MapLanes({
  map,
  visible,
  onSave,
  noun,
  keepOne = false,
  multiline = false,
  html = false,
  textProps = {size: "3"},
}) {
  // The one lane asked to add a value in ("Add Français"); its editor shows
  // until something is saved there.
  const [adding, setAdding] = useState(null);
  // A multi-line editor takes the lane's width; a single line is sized to its
  // text (.metadata-value).
  const valueClass = multiline ? undefined : "metadata-value";

  return visible.map((code) => {
    const values = arrayAt(map, code);
    const autonym = languageAutonym(code);
    return (
      <Lane key={code} code={code}>
        {values.length > 0 ? (
          values.map((value, index) => (
            <Box key={`${index}:${value}`} className={valueClass}>
              <InlineTextEditor
                value={value}
                lang={langAttribute(code)}
                // Clearing a value takes it out of its language, which stays as
                // [] when it was the last.
                onSave={(next) => onSave(setLanguageValue(map, code, index, next || null))}
                multiline={multiline}
                allowEmpty={!keepOne || countValues(map) > 1}
                clearable
                html={html}
                ariaLabel={`Save ${noun.toLowerCase()}`}
                placeholder={`${noun} in ${autonym}`}
                textProps={textProps}
                fieldSize="2"
              />
            </Box>
          ))
        ) : adding === code ? (
          <Box className={valueClass}>
            <InlineTextEditor
              value=""
              autoEdit
              lang={langAttribute(code)}
              onSave={async (next) => {
                if (!next) return;
                await onSave(setLanguageValue(map, code, 0, next));
                setAdding(null);
              }}
              multiline={multiline}
              allowEmpty={multiline}
              html={html}
              ariaLabel={`Save ${noun.toLowerCase()}`}
              placeholder={`${noun} in ${autonym}`}
              textProps={textProps}
              fieldSize="2"
            />
          </Box>
        ) : (
          <AddLanguageButton code={code} onClick={() => setAdding(code)} />
        )}
      </Lane>
    );
  });
}
