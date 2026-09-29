import {
  Box,
  Button,
  Flex,
  IconButton,
  Table,
  Text,
  Tooltip,
} from "@radix-ui/themes";
import {PlusIcon, TrashIcon} from "@radix-ui/react-icons";
import InlineTextEditor from "../InlineTextEditor";
import {readLanguageMap, toLanguageMap} from "../../lib/languageMap";

export default function MetadataPanel({manifest, onSaveSummary, onSaveMetadata}) {
  const entries = Array.isArray(manifest?.metadata) ? manifest.metadata : [];
  const summary = readLanguageMap(manifest?.summary)[0] || "";

  // Every row mutation rebuilds and saves the whole metadata array — the API
  // takes the field wholesale.
  const saveEntries = (next) => onSaveMetadata(next.length ? next : null);

  const updateEntry = (index, mutate) =>
    saveEntries(entries.map((entry, i) => (i === index ? mutate(entry) : entry)));

  return (
    <Flex direction="column" gap="5" className="metadata-panel">
      <Flex direction="column" className="metadata-fields">
        <Box>
          <Text as="p" size="2" color="gray" mb="1">Description</Text>
          <InlineTextEditor
            value={summary}
            onSave={(value) => onSaveSummary(value ? toLanguageMap([value]) : null)}
            multiline
            allowEmpty
            ariaLabel="Save description"
            placeholder="No description"
            html
            textProps={{size: "3"}}
            fieldSize="2"
          />
        </Box>

        <Box>
          <Text as="p" size="2" color="gray" mb="2">Additional fields</Text>
          {entries.length === 0 ? (
            <Text as="p" size="3" color="gray">No additional fields.</Text>
          ) : (
            <Table.Root variant="ghost" size="2" className="metadata-table">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Field</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Values</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {entries.map((entry, index) => {
                  const values = readLanguageMap(entry.value);
                  return (
                    <Table.Row key={index}>
                      <Table.RowHeaderCell>
                        <InlineTextEditor
                          value={readLanguageMap(entry.label)[0] || ""}
                          onSave={(value) =>
                            updateEntry(index, (e) => ({...e, label: toLanguageMap([value])}))
                          }
                          ariaLabel="Save field name"
                          placeholder="Field name"
                          textProps={{weight: "bold", size: "3"}}
                          fieldSize="2"
                        />
                      </Table.RowHeaderCell>
                      <Table.Cell>
                        <Flex direction="column" gap="2">
                          {values.map((value, valueIndex) => (
                            /* Keyed on the value as well as its position: removing
                               one shifts every value after it up an index, and an
                               index-only key would hand the open editor — still in
                               edit mode — to the value that moved into its place. */
                            <Box key={`${valueIndex}:${value}`} className="metadata-value">
                              <InlineTextEditor
                                value={value}
                                onSave={(next) =>
                                  updateEntry(index, (e) => ({
                                    ...e,
                                    value: toLanguageMap(
                                      values.map((v, i) => (i === valueIndex ? next : v)),
                                    ),
                                  }))
                                }
                                ariaLabel="Save value"
                                // Values may be HTML; field names (labels) may not.
                                html
                                textProps={{size: "3"}}
                                fieldSize="2"
                                // Removal lives in the value's own editor, shown
                                // only once it is open: a trash can on every value
                                // line read as a second delete for the whole field.
                                // A field's last value has none — removing that is
                                // removing the field, which is the row's trash.
                                onRemove={
                                  values.length > 1
                                    ? () =>
                                        updateEntry(index, (e) => ({
                                          ...e,
                                          value: toLanguageMap(
                                            values.filter((_, i) => i !== valueIndex),
                                          ),
                                        }))
                                    : undefined
                                }
                                removeLabel="Remove value"
                              />
                            </Box>
                          ))}
                          <Box>
                            <Button
                              type="button"
                              variant="ghost"
                              size="2"
                              onClick={() =>
                                updateEntry(index, (e) => ({
                                  ...e,
                                  value: toLanguageMap([...values, "New value"]),
                                }))
                              }
                            >
                              <PlusIcon /> Add value
                            </Button>
                          </Box>
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <Tooltip content="Remove field">
                          <IconButton
                            type="button"
                            variant="soft"
                            color="red"
                            size="1"
                            aria-label="Remove field"
                            onClick={() => saveEntries(entries.filter((_, i) => i !== index))}
                          >
                            <TrashIcon />
                          </IconButton>
                        </Tooltip>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          )}
          <Box mt="2">
            <Button
              type="button"
              variant="soft"
              size="2"
              onClick={() =>
                saveEntries([
                  ...entries,
                  {label: toLanguageMap(["New field"]), value: toLanguageMap(["New value"])},
                ])
              }
            >
              <PlusIcon /> Add field
            </Button>
          </Box>
        </Box>
      </Flex>
    </Flex>
  );
}
