"use client";

import {useCallback, useEffect, useState} from "react";
import NextLink from "next/link";
import {useParams} from "next/navigation";
import {Button, Callout, Code, Flex, Link, Table, Text, TextField} from "@radix-ui/themes";
import {InfoCircledIcon, MagnifyingGlassIcon} from "@radix-ui/react-icons";
import {apiFetch, collectionSearchUrl} from "../lib/api";
import {imageRequestUrl} from "../lib/canvasAssets";
import PageHeading from "../components/PageHeading";
import PageReady from "../components/PageReady";

// What a collection's LIVE search index holds: the one a consuming site
// queries, read through the API. Deliberately unlinked and plain. It is a way
// to see what publishing put there, until the proper way to inspect and manage
// indexes is designed.
//
// Searches on submit, never per keystroke: each one is a request to the
// search collection, which wakes it if idle (~10s for the first).
export default function CollectionSearchPage() {
  const {slug: rawSlug} = useParams();
  const slug = rawSlug ? decodeURIComponent(rawSlug) : null;
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [searching, setSearching] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const runSearch = useCallback(
    async (q) => {
      const url = collectionSearchUrl(slug, {q});
      if (!url) {
        setError("Collection API URL is not configured.");
        setLoaded(true);
        return;
      }
      setSearching(true);
      try {
        setResult(await apiFetch(url, {errorMessage: "Unable to search this collection"}));
        setError(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setSearching(false);
        setLoaded(true);
      }
    },
    [slug],
  );

  // An empty search first, so the page opens on everything in the index and
  // its count: the answer to "did it publish?".
  useEffect(() => {
    if (slug) runSearch("");
  }, [slug, runSearch]);

  const submit = (event) => {
    event.preventDefault();
    runSearch(query.trim());
  };

  return (
    <PageReady ready={loaded}>
      <Flex direction="column" gap="5">
        <Flex direction="column" align="center" gap="1">
          <PageHeading>{result?.collection?.label || slug}</PageHeading>
          <Text size="2" color="gray">
            Published search index
          </Text>
        </Flex>

        <form onSubmit={submit}>
          <Flex gap="2">
            <TextField.Root
              style={{flex: 1}}
              placeholder="Search titles"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search titles"
            >
              <TextField.Slot>
                <MagnifyingGlassIcon />
              </TextField.Slot>
            </TextField.Root>
            <Button type="submit" loading={searching}>
              Search
            </Button>
          </Flex>
        </form>

        {error && (
          <Callout.Root color="red" size="1">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}

        {result && !result.published && (
          <Callout.Root color="gray" size="1">
            <Callout.Icon><InfoCircledIcon /></Callout.Icon>
            <Callout.Text>
              Nothing is live yet: the search index for this collection has not been published.
            </Callout.Text>
          </Callout.Root>
        )}

        {result?.published && (
          <Flex direction="column" gap="3">
            {/* Which index answered, so a result can be traced to the run
                that produced it. */}
            <Text size="1" color="gray">
              {result.total} result{result.total === 1 ? "" : "s"}
              {result.q ? <> for “{result.q}”</> : null} from <Code size="1" variant="ghost" color="gray">{result.alias}</Code>
              {result.liveIndex ? (
                <> → <Code size="1" variant="ghost" color="gray">{result.liveIndex}</Code></>
              ) : null}
            </Text>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell aria-label="Thumbnail" />
                  <Table.ColumnHeaderCell>Title</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Canvases</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {result.hits.map((hit) => (
                  <Table.Row key={hit.workId}>
                    <Table.Cell>
                      <span className="work-thumb">
                        {hit.thumbnails[0] && (
                          <img
                            src={imageRequestUrl(hit.thumbnails[0], {region: "square", size: "64,64"})}
                            alt=""
                            loading="lazy"
                          />
                        )}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="work-title-cell">
                      <Link asChild>
                        <NextLink
                          prefetch={false}
                          href={`/collection/${encodeURIComponent(slug)}/work/${encodeURIComponent(hit.workId)}`}
                        >
                          {hit.title || hit.workId}
                        </NextLink>
                      </Link>
                    </Table.Cell>
                    <Table.Cell>{hit.itemCount}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Flex>
        )}
      </Flex>
    </PageReady>
  );
}
