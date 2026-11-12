import {useEffect, useState} from "react";
import {Badge, Box, Button, Callout, Card, Flex, IconButton, Text, TextField, Tooltip} from "@radix-ui/themes";
import ConfirmIconButton from "../ConfirmIconButton";
import {ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon} from "@radix-ui/react-icons";
import {COLLECTION_API_BASE, apiFetch} from "../../lib/api";
import {langAttribute, languageAutonym, languageName} from "../../lib/languageMap";

// The languages a collection is described in, most preferred first. Every work
// in the collection takes this list as its own: the work page's Metadata tab
// gives each one a lane, in this order, and the first is the preferred language
// the page heading and the viewer read in. Stored on the collection's entry in
// the root register (app/shared/collection.js, LANGUAGES_KEY) and copied onto the
// collection document.
//
// Every change saves at once, the whole list each time: it is short, and the
// order is the point of it, so there is no partial edit worth holding back.
//
// Mounts on first open and then only hides, like the publish panel, so a visit
// that never opens it never asks.

// The server's check (sanitizeCollectionLanguages), for an answer while typing.
const languageTagPattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();

function LanguagesBody({slug, canEdit}) {
  const [languages, setLanguages] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");

  const endpoint = `${COLLECTION_API_BASE}/${encodeURIComponent(slug)}/languages`;

  useEffect(() => {
    let cancelled = false;
    apiFetch(endpoint, {errorMessage: "Unable to load the collection's languages"})
      .then((data) => !cancelled && setLanguages(data.languages || []))
      .catch((err) => {
        if (cancelled) return;
        setLanguages([]);
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  // Shown at once, and put back if the save is refused.
  const save = async (next) => {
    const previous = languages;
    setLanguages(next);
    setSaving(true);
    setError(null);
    try {
      const data = await apiFetch(endpoint, {
        method: "PUT",
        body: {languages: next},
        errorMessage: "Unable to save the collection's languages",
      });
      setLanguages(data.languages);
      return true;
    } catch (err) {
      setLanguages(previous);
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const tag = draft.trim();
  const valid = languageTagPattern.test(tag);
  const duplicate = valid && (languages || []).some((code) => sameTag(code, tag));
  const preview = valid ? languageAutonym(tag) : null;

  const add = async () => {
    if (!valid || duplicate) return;
    if (await save([...languages, tag])) setDraft("");
  };

  const move = (index, by) => {
    const next = [...languages];
    const [code] = next.splice(index, 1);
    next.splice(index + by, 0, code);
    save(next);
  };

  if (languages === null) {
    return <Text as="p" color="gray">Loading languages…</Text>;
  }

  return (
    <Flex direction="column" gap="4">
      {/* Headed like the Works section's count and the work page's sections. */}
      <Text asChild size="5" weight="bold">
        <h3 className="section-heading">Languages</h3>
      </Text>
      <Text as="p" size="2" color="gray">
        Every work in this collection shows its labels and values in these languages, in this
        order. The first is the preferred language: the one a work&rsquo;s title and viewer read
        in.
      </Text>

      {error && (
        <Callout.Root color="red" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      {languages.length === 0 ? (
        <Text as="p" size="3" color="gray">
          No languages yet. Until there are, each work shows whatever languages its own values
          carry.
        </Text>
      ) : (
        <ol className="collection-languages field-cards">
          {languages.map((code, index) => {
            const autonym = languageAutonym(code);
            const name = languageName(code);
            return (
              <li key={code}>
                <Card size="2" className="collection-language-card">
                  <Flex align="center" gap="4">
                    {/* The code on a dark chip, as the work page's toggles show
                        it, then the language's own name and, where it differs,
                        the viewer's. */}
                    <span className="language-code-chip">{code}</span>
                    <Flex direction="column" gap="0" style={{flex: 1, minWidth: 0}}>
                      <Flex align="center" gap="2">
                        <Text size="3" weight="bold" lang={langAttribute(code)}>
                          {autonym}
                        </Text>
                        {index === 0 && (
                          <Badge size="1" variant="soft" color="gray">
                            preferred
                          </Badge>
                        )}
                      </Flex>
                      {name !== autonym && name !== code && (
                        <Text size="2" color="gray">
                          {name}
                        </Text>
                      )}
                    </Flex>
                    {canEdit && (
                      <Flex gap="2" align="center">
                        <Tooltip content="Move up">
                          <IconButton
                            type="button"
                            variant="soft"
                            color="gray"
                            size="1"
                            aria-label={`Move ${autonym} up`}
                            disabled={index === 0 || saving}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUpIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip content="Move down">
                          <IconButton
                            type="button"
                            variant="soft"
                            color="gray"
                            size="1"
                            aria-label={`Move ${autonym} down`}
                            disabled={index === languages.length - 1 || saving}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDownIcon />
                          </IconButton>
                        </Tooltip>
                        {/* Asks first, like every other remove. Removing a
                            language from the list changes no work: the values
                            stay in each manifest, and the work page still shows
                            them, marked as outside the collection's set. */}
                        <ConfirmIconButton
                          label={`Remove ${autonym}`}
                          icon={<TrashIcon />}
                          color="red"
                          disabled={saving}
                          onConfirm={() => save(languages.filter((_, i) => i !== index))}
                        />
                      </Flex>
                    )}
                  </Flex>
                </Card>
              </li>
            );
          })}
        </ol>
      )}

      {canEdit && (
        <Box>
          <Flex
            asChild
            align="center"
            gap="2"
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                add();
              }}
            >
              <TextField.Root
                size="2"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Language tag, such as fr or pt-BR"
                aria-label="Language tag"
                style={{width: "calc(280 * var(--px))"}}
              />
              <Button type="submit" size="2" disabled={!valid || duplicate || saving}>
                <PlusIcon /> Add language
              </Button>
            </form>
          </Flex>
          {tag && (
            <Text as="p" size="1" color={valid && !duplicate ? "gray" : "red"} mt="1">
              {!valid
                ? "A language tag is two or three letters, optionally followed by a region or script, such as fr, pt-BR or ar-Latn."
                : duplicate
                  ? `${preview} is already in the list.`
                  : <>Adds <span lang={tag}>{preview}</span>{languageName(tag) !== preview ? ` (${languageName(tag)})` : ""}.</>}
            </Text>
          )}
        </Box>
      )}
    </Flex>
  );
}

export default function CollectionLanguagesPanel({active, slug, canEdit}) {
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <div hidden={!active}>
      <Card size="3" className="panel manifest-panel">
        <LanguagesBody slug={slug} canEdit={canEdit} />
      </Card>
    </div>
  );
}
