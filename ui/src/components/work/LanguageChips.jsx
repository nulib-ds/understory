import {Checkbox, Text, Tooltip} from "@radix-ui/themes";
import {NONE, languageName} from "../../lib/languageMap";
import {useLanguageLanes} from "../../lib/workLanguage";

// The checkboxes that turn the work page's language lanes on and off, at the
// right of its section row, on every tab. They read the page's lane state
// (useLanguageLanes, lib/workLanguage.js), the same object the Metadata and
// Assets tabs draw their lanes from. The preferred language is named in its
// tooltip and accessible name. A language the work uses but its collection
// does not list is dashed.
//
// Drawn as one track, like the SegmentedControl beside it, but each segment is
// a checkbox, so any number can be on. A checked segment is lifted out of the
// track the way the segmented control's selected item is
// (.language-toggle--on).
//
// These only show and hide a language's lanes on this page. Nothing is written:
// a hidden language's values are all still in the manifest, and still
// published. Each tooltip says so.
export default function LanguageChips() {
  const {lanes, isOn, toggle, preferred, collectionLanguages} = useLanguageLanes();
  return (
    // No visible label: the checkboxes and their tooltips say what they do.
    // The group is still named for assistive technology.
    <div className="language-toggles" role="group" aria-label="Show languages">
      {lanes.map((code) => {
        const on = isOn(code);
        const outside = code !== NONE && !collectionLanguages.includes(code);
        const name = code === NONE ? "None" : languageName(code);
        const about =
          code === NONE
            ? "Text with no language."
            : outside
              ? "Used by this work, but not one of the collection's languages."
              : code === preferred
                ? "The collection's preferred language."
                : null;
        const action = on
          ? `Hide ${name} on this page. Its values stay in the manifest.`
          : `Show ${name} on this page.`;
        const tip = about ? `${about} ${action}` : action;
        return (
          <Tooltip key={code} content={tip}>
            {/* The whole segment is the label, so a click anywhere on it
                toggles the checkbox. */}
            <Text
              as="label"
              className={[
                "language-toggle",
                on ? "language-toggle--on" : "language-toggle--off",
                outside ? "language-toggle--outside" : "",
              ].filter(Boolean).join(" ")}
            >
              <Checkbox
                size="1"
                color="gray"
                highContrast
                checked={on}
                onCheckedChange={() => toggle(code)}
                // The code alone is shown. The name, and "preferred", are in
                // the accessible name and the tooltip.
                aria-label={`${name}${code === preferred ? " (preferred)" : ""}`}
              />
              {code}
            </Text>
          </Tooltip>
        );
      })}
    </div>
  );
}
