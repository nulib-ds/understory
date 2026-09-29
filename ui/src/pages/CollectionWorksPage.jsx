import {useCallback, useEffect, useRef, useState} from "react";
import {useNavigate, useParams, useSearchParams} from "react-router-dom";
import {Box, Button, Callout, Card, Flex, Text, TextField} from "@radix-ui/themes";
import {PlusIcon} from "@radix-ui/react-icons";
import {
  COLLECTION_API_BASE,
  MANIFEST_API_BASE,
  apiFetch,
  manifestApiUrl,
  collectionWorksUrl,
} from "../lib/api";
import {ROLE_ADMIN, useSession} from "../lib/session";
import PageHeading from "../components/PageHeading";
import PageReady from "../components/PageReady";
import AddWorkModal from "../components/works/AddWorkModal";
import WorksTable from "../components/works/WorksTable";
import PublishPanel from "../components/works/PublishPanel";
import CollectionImportBanner from "../components/collections/CollectionImportBanner";

function WorksListPanel({
  manifestApiAvailable,
  manifestError,
  manifestLoading,
  works,
  total,
  counts,
  slug,
  canPublish,
  onPublished,
  query,
  resultsQuery,
  onQueryChange,
  onOpenManifestModal,
  onDeleteManifest,
  workPath,
  heading,
}) {
  const session = useSession();
  const isAdmin = session.role === ROLE_ADMIN;
  // The API scopes reads to the caller's grants, so someone with neither the
  // admin role nor a single grant gets an empty list. Say why, rather than
  // showing a bare table that looks like the collection is empty.
  const noAccess = !isAdmin && session.collections.length === 0;

  return (
    <Flex direction="column" gap="5">
      {/* Not editable, unlike every other heading in the app: the slug is the
          collection's identity, so renaming is impossible by construction. */}
      <Flex direction="column" align="center" gap="1">
        <PageHeading>{heading}</PageHeading>
        {/* Counts are for the whole collection, not the loaded page — a
            summary computed from the rows on screen would only be right on
            page one. The unpublished figure rides along because it answers the
            same question: how much is here, and how much of it is live. The
            publish aside states it too, but only in some of its states. */}
        <Flex align="center" gap="2">
          {/* resultsQuery, not query: the rows on screen answer the filter
              as it was when they were fetched, and the count has to describe
              those rows, not the keystroke that has not been sent yet. */}
          <Text size="1" color="gray">
            {resultsQuery.trim()
              ? `${works.length} of ${total} works match`
              : `${total} work${total === 1 ? "" : "s"}`}
          </Text>
          {counts && counts.new + counts.changed > 0 && (
            <>
              <Text size="1" color="gray" aria-hidden>
                ·
              </Text>
              <Text size="1" color="orange">
                {counts.new + counts.changed} unpublished
                {counts.new > 0 && counts.changed > 0
                  ? ` (${counts.new} new, ${counts.changed} changed)`
                  : ""}
              </Text>
            </>
          )}
        </Flex>
      </Flex>
      <div className="collection-layout">
        <div className="collection-main">
      <Card size="3" className="panel manifest-panel">
        <Flex justify="between" align="center" gap="3" mb="4">
          <TextField.Root
            size="3"
            placeholder="Filter works…"
            style={{flex: 1}}
            value={query}
            onChange={(evt) => onQueryChange(evt.target.value)}
          />
          <Button
            type="button"
            size="3"
            onClick={onOpenManifestModal}
            disabled={!manifestApiAvailable || noAccess}
          >
            <PlusIcon /> Add
          </Button>
        </Flex>
        <Box className="panel-body manifest-panel-body">
          {!manifestApiAvailable && (
            <Callout.Root color="red" size="1" mb="3">
              <Callout.Text>
                Work API URL is not configured. Update VITE_MANIFEST_API_URL to point at the deployed endpoint.
              </Callout.Text>
            </Callout.Root>
          )}
          {noAccess && (
            <Callout.Root color="gray" size="1" mb="3">
              <Callout.Text>
                You don&rsquo;t have access to any collections yet, so there are no works to show. An
                administrator can grant you access from the Users section.
              </Callout.Text>
            </Callout.Root>
          )}
          <WorksTable
            works={works}
            onDelete={onDeleteManifest}
            workPath={workPath}
            filtered={resultsQuery.trim().length > 0}
            loading={manifestLoading}
            error={manifestApiAvailable ? manifestError : null}
          />
        </Box>
      </Card>
        </div>
        {/* Publishing is about the collection as a whole, not about any one
            row, so it reads as a sidebar to the works list rather than as a
            banner above it. */}
        <aside className="collection-aside">
          <PublishPanel
            slug={slug}
            counts={counts}
            canPublish={canPublish}
            onPublished={onPublished}
          />
        </aside>
      </div>
    </Flex>
  );
}

// The works list route. Still backed by GET /manifests for now — the
// collection-scoped route replaces that later; this is the landing pad for it.
export default function CollectionWorksPage() {
  const {slug: rawSlug} = useParams();
  const slug = rawSlug ? decodeURIComponent(rawSlug) : null;
  const navigate = useNavigate();

  // Every work now lives under its collection, so a work's URL carries the slug.
  const workPath = useCallback(
    (identifier) =>
      `/collection/${encodeURIComponent(slug)}/work/${encodeURIComponent(identifier)}`,
    [slug],
  );
  const selectWork = useCallback(
    (identifier) => {
      navigate(identifier ? workPath(identifier) : `/collection/${encodeURIComponent(slug)}`);
    },
    [navigate, slug, workPath],
  );


  const manifestApiAvailable = Boolean(MANIFEST_API_BASE);
  const [works, setWorks] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState(null);
  const [collectionLabel, setCollectionLabel] = useState("");
  // Whether the first load has settled. Deliberately not a "loading" flag
  // that goes true on every refresh: that swapped the whole table for
  // "Loading works…" on each keystroke of the filter, after every delete and
  // when a publish finished. Later refreshes keep the rows on screen and
  // replace them when the answer arrives.
  const [worksLoaded, setWorksLoaded] = useState(false);
  // The filter the rows on screen were fetched with, which lags `query` by a
  // round trip. See the count in WorksListPanel.
  const [resultsQuery, setResultsQuery] = useState("");
  const [worksError, setWorksError] = useState(null);

  // Cosmetic only: canPublish in app/shared/access.js is what actually decides,
  // and it re-derives from the same token. Group claims can be up to an hour
  // stale, so this gates a button, never a read.
  const pageSession = useSession();
  const canPublish =
    pageSession.role === ROLE_ADMIN || pageSession.collections.includes(slug);
  const [isManifestModalOpen, setManifestModalOpen] = useState(false);
  const [manifestModalStep, setManifestModalStep] = useState("choose");
  const [manifestForm, setManifestForm] = useState({label: ""});
  const [manifestFormError, setManifestFormError] = useState(null);
  const [manifestFormSubmitting, setManifestFormSubmitting] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const [importError, setImportError] = useState(null);
  const [importFetching, setImportFetching] = useState(false);
  const [importConfirming, setImportConfirming] = useState(false);

  // One request: the collection's works, filtered and paged by the server,
  // with the collection's own label and the whole-collection sync counts
  // riding along. Replaces the corpus listing plus a separate search call.
  const refreshWorks = useCallback(async () => {
    if (!slug) return;
    const q = queryRef.current;
    const endpoint = collectionWorksUrl(slug, {q});
    if (!endpoint) {
      setWorksError("Collection API URL is not configured. Set VITE_COLLECTION_API_URL and redeploy.");
      setWorksLoaded(true);
      return;
    }
    try {
      const data = await apiFetch(endpoint, {errorMessage: "Unable to load works"});
      setWorks(Array.isArray(data.works) ? data.works : []);
      setTotal(data.total ?? 0);
      setCounts(data.counts || null);
      setCollectionLabel(data.collection?.label || slug);
      setResultsQuery(q);
      setWorksError(null);
    } catch (err) {
      setWorks([]);
      setWorksError(err.message);
    } finally {
      setWorksLoaded(true);
    }
  }, [slug]);

  const handleDeleteManifest = useCallback(
    async (identifier) => {
      const endpoint = manifestApiUrl(encodeURIComponent(identifier));
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      await apiFetch(endpoint, {method: "DELETE", errorMessage: "Unable to delete work"});
      await refreshWorks();
    },
    [refreshWorks],
  );

  const handleManifestFieldChange = useCallback((name, value) => {
    setManifestForm((prev) => ({...prev, [name]: value}));
  }, []);

  const handleOpenManifestModal = () => {
    if (!manifestApiAvailable) return;
    setManifestModalStep("choose");
    setManifestForm({label: ""});
    setManifestFormError(null);
    setImportUrl("");
    setImportPreview(null);
    setImportError(null);
    setManifestModalOpen(true);
  };

  const handleCloseManifestModal = () => {
    setManifestModalOpen(false);
    setManifestFormError(null);
    setImportError(null);
  };

  const handleModalBack = () => {
    if (manifestModalStep === "import-preview") {
      setImportPreview(null);
      setImportError(null);
      setManifestModalStep("import-url");
    } else {
      setManifestModalStep("choose");
    }
  };

  // The collection is the page you are on, so it is never asked for. The slug
  // comes straight from the route: the API takes a slug now and does not reduce
  // a label into one, so sending collectionLabel here would only work for the
  // collections whose name happens to slugify back to their id.
  const newWorkCollectionBody = () => ({collection: slug});

  const handleManifestSubmit = async (event) => {
    event.preventDefault();
    const label = manifestForm.label.trim();
    if (!label) {
      setManifestFormError("A title is required");
      return;
    }
    setManifestFormSubmitting(true);
    setManifestFormError(null);
    try {
      const endpoint = manifestApiUrl();
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: {label, ...newWorkCollectionBody()},
        errorMessage: "Unable to create work",
      });
      await refreshWorks();
      selectWork(data.manifest?.identifier);
      setManifestModalOpen(false);
    } catch (err) {
      setManifestFormError(err.message);
    } finally {
      setManifestFormSubmitting(false);
    }
  };

  const handleImportFetch = async (event) => {
    event.preventDefault();
    const sourceUrl = importUrl.trim();
    if (!sourceUrl) {
      setImportError("A manifest URL is required");
      return;
    }
    setImportFetching(true);
    setImportError(null);
    try {
      const endpoint = manifestApiUrl("import/preview");
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: {sourceUrl},
        errorMessage: "Unable to fetch that manifest",
      });
      setImportPreview(data);
      setManifestModalStep("import-preview");
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportFetching(false);
    }
  };

  const handleImportConfirm = async () => {
    if (!importPreview) return;
    setImportConfirming(true);
    setImportError(null);
    try {
      const endpoint = manifestApiUrl("import");
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: {
          sourceUrl: importPreview.sourceUrl,
          manifest: importPreview.manifest,
          ...newWorkCollectionBody(),
        },
        errorMessage: "Unable to import that manifest",
      });
      await refreshWorks();
      selectWork(data.manifest?.identifier);
      setManifestModalOpen(false);
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportConfirming(false);
    }
  };

  // `q` lives in the URL so the filter survives the list -> work -> back round
  // trip, which is the whole flow. `replace` so the back button does not walk
  // every keystroke. The page offset deliberately does NOT live here.
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const setQuery = useCallback(
    (next) => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set("q", next);
      else params.delete("q");
      setSearchParams(params, {replace: true});
    },
    [searchParams, setSearchParams],
  );

  // Held in a ref as well as state so refreshWorks stays stable: it is called
  // from the write paths too, and a fetch keyed on every keystroke would make
  // every one of them a new function.
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Same 300ms debounce the search box used before the two collapsed into one
  // request — the filter is now a server round trip, so it matters more.
  useEffect(() => {
    if (!slug) return undefined;
    const timer = setTimeout(() => refreshWorks(), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [slug, query, refreshWorks]);

  return (
    <PageReady ready={worksLoaded}>
      {/* Only renders while a collection import is running, or afterwards if
          it hit trouble or dropped something. Silent the rest of the time. */}
      <CollectionImportBanner slug={slug} onProgress={refreshWorks} />
      <WorksListPanel
        manifestApiAvailable={manifestApiAvailable}
        manifestError={worksError}
        manifestLoading={!worksLoaded}
        works={works}
        total={total}
        counts={counts}
        slug={slug}
        canPublish={canPublish}
        onPublished={refreshWorks}
        query={query}
        resultsQuery={resultsQuery}
        onQueryChange={setQuery}
        onOpenManifestModal={handleOpenManifestModal}
        onDeleteManifest={handleDeleteManifest}
        workPath={workPath}
        heading={collectionLabel}
      />
      <AddWorkModal
        open={isManifestModalOpen}
        onClose={handleCloseManifestModal}
        step={manifestModalStep}
        onSelectStep={setManifestModalStep}
        onBack={handleModalBack}
        createForm={manifestForm}
        onCreateChange={handleManifestFieldChange}
        onCreateSubmit={handleManifestSubmit}
        createSubmitting={manifestFormSubmitting}
        createError={manifestFormError}
        importUrl={importUrl}
        onImportUrlChange={setImportUrl}
        onImportFetch={handleImportFetch}
        importFetching={importFetching}
        importError={importError}
        importPreview={importPreview}
        onImportConfirm={handleImportConfirm}
        importConfirming={importConfirming}
      />
    </PageReady>
  );
}
