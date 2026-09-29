import {useEffect, useState} from "react";
import {Link as RouterLink, useNavigate} from "react-router-dom";
import {
  AlertDialog,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  IconButton,
  Link,
  Table,
  Text,
} from "@radix-ui/themes";
import {PlusIcon, TrashIcon} from "@radix-ui/react-icons";
import {COLLECTION_API_BASE, apiFetch} from "../lib/api";
import {suggestCollectionSlug, collectionSlugError} from "../lib/collectionSlug";
import {ROLE_ADMIN, useSession} from "../lib/session";
import PageHeading from "../components/PageHeading";
import AddCollectionModal from "../components/collections/AddCollectionModal";

const EMPTY_FORM = {label: "", slug: "", slugEdited: false};

// The root collection caches a thumbnail per collection precisely so a UI like
// this one does not have to open every leaf. Prefer the image service (a square
// crop is then free) and fall back to the cached derivative URL.
function collectionThumbnailUrl(thumbnail, size = 48) {
  const first = Array.isArray(thumbnail) ? thumbnail[0] : null;
  if (!first) return null;
  const service = Array.isArray(first.service) ? first.service[0] : first.service;
  const serviceId = service?.id || service?.["@id"];
  if (serviceId) {
    return `${serviceId.replace(/\/$/, "")}/square/${size},${size}/0/default.jpg`;
  }
  return first.id || null;
}

// .../presentation/collection/{slug}/collection.json
function slugFromCollectionId(id) {
  const match = /\/collection\/([^/]+)\/collection\.json$/.exec(id || "");
  return match ? match[1] : null;
}

function hideOnError(event) {
  event.currentTarget.style.visibility = "hidden";
}

function CollectionRow({collection, isRoot = false, canDelete = false, onDelete}) {
  const thumbnail = collectionThumbnailUrl(collection.thumbnail);
  return (
    <Table.Row className={isRoot ? "collection-row--root" : undefined}>
      <Table.RowHeaderCell>
        <Flex align="center" gap="3">
          <span className="collection-thumb">
            {thumbnail && <img src={thumbnail} alt="" loading="lazy" onError={hideOnError} />}
          </span>
          {isRoot ? (
            <Text weight="bold">{collection.label}</Text>
          ) : (
            /* Link, not Text: Text carries no link styling, so the anchor
               fell back to the UA default — browser blue and underlined —
               instead of the accent every other link in the app uses. */
            <Link asChild weight="medium">
              <RouterLink to={`/collection/${encodeURIComponent(collection.slug)}`}>
                {collection.label}
              </RouterLink>
            </Link>
          )}
          {isRoot && (
            <Badge size="1" variant="soft" color="gray" radius="full">
              Root
            </Badge>
          )}
        </Flex>
      </Table.RowHeaderCell>
      <Table.Cell>
        <Badge size="1" variant="soft" radius="full" className="collection-slug">
          {collection.slug}
        </Badge>
      </Table.Cell>
      <Table.Cell>
        <Text size="2">{collection.itemCount ?? "—"}</Text>
      </Table.Cell>
      {/* Unlabelled, like the works table's actions cell: it holds a control,
          not a value, so a heading over it would name nothing. */}
      <Table.Cell>
        <Flex align="center" justify="end" gap="3">
          {canDelete && (
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <IconButton size="1" variant="ghost" color="red" aria-label={`Delete ${collection.label}`}>
                  <TrashIcon />
                </IconButton>
              </AlertDialog.Trigger>
              <AlertDialog.Content maxWidth="calc(480 * var(--px))">
                <AlertDialog.Title>Delete {collection.label}?</AlertDialog.Title>
                <AlertDialog.Description size="2">
                  This removes the collection and its IIIF document. It holds no works, so nothing
                  else is affected.
                </AlertDialog.Description>
                <Flex gap="3" mt="4" justify="end">
                  <AlertDialog.Cancel>
                    <Button variant="soft" color="gray">
                      Cancel
                    </Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action>
                    <Button color="red" onClick={() => onDelete(collection)}>
                      Delete
                    </Button>
                  </AlertDialog.Action>
                </Flex>
              </AlertDialog.Content>
            </AlertDialog.Root>
          )}
        </Flex>
      </Table.Cell>
    </Table.Row>
  );
}

// The home page: the root collection's members. Admins can create a collection,
// import one wholesale from a source IIIF Collection, or delete an empty one.
export default function CollectionsPage() {
  const session = useSession();
  // Same scoping as the works list: no admin role and no grant means the API
  // returns an empty set, which should read as "no access", not "none exist".
  const noAccess = session.role !== ROLE_ADMIN && session.collections.length === 0;
  const available = Boolean(COLLECTION_API_BASE);
  const [collections, setCollections] = useState([]);
  const [root, setRoot] = useState(null);
  const [loading, setLoading] = useState(available);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const isAdmin = session.role === ROLE_ADMIN;
  const navigate = useNavigate();

  // The Add flow branches the same way Add Work does:
  //   choose -> create
  //   choose -> import-url -> import-preview
  const [step, setStep] = useState("choose");
  const [createForm, setCreateForm] = useState(EMPTY_FORM);
  const [createError, setCreateError] = useState(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const [importForm, setImportForm] = useState(EMPTY_FORM);
  const [importError, setImportError] = useState(null);
  const [importFetching, setImportFetching] = useState(false);
  const [importConfirming, setImportConfirming] = useState(false);

  useEffect(() => {
    if (!available) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await apiFetch(COLLECTION_API_BASE, {errorMessage: "Unable to load collections"});
        if (cancelled) return;
        setCollections(Array.isArray(data.collections) ? data.collections : []);
        setRoot(data.root || null);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [available]);

  const openModal = () => {
    setStep("choose");
    setCreateForm(EMPTY_FORM);
    setCreateError(null);
    setImportUrl("");
    setImportPreview(null);
    setImportForm(EMPTY_FORM);
    setImportError(null);
    setAdding(true);
  };

  const handleModalBack = () => {
    if (step === "import-preview") {
      setImportPreview(null);
      setImportError(null);
      setStep("import-url");
    } else {
      setStep("choose");
    }
  };

  // Both branches send the same two fields and both validate them the same way.
  // The server validates again and never derives one from the other.
  const validateForm = (form) => {
    if (!form.label.trim()) return "A name is required";
    return collectionSlugError(form.slug);
  };

  const handleCreateSubmit = async (event) => {
    event.preventDefault();
    const problem = validateForm(createForm);
    if (problem) {
      setCreateError(problem);
      return;
    }
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const data = await apiFetch(COLLECTION_API_BASE, {
        method: "POST",
        body: {label: createForm.label.trim(), slug: createForm.slug},
        errorMessage: "Unable to create collection",
      });
      // The API returns the whole list back, so the table never has to refetch.
      if (Array.isArray(data.collections)) setCollections(data.collections);
      setError(null);
      setAdding(false);
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreateSubmitting(false);
    }
  };

  // Look at the source without writing anything. The response is a SUMMARY —
  // label, count, thumbnail — not the Collection document: a large one would
  // exceed Lambda's response cap, so the run re-fetches it server-side.
  const handleImportFetch = async (event) => {
    event.preventDefault();
    const sourceUrl = importUrl.trim();
    if (!sourceUrl) {
      setImportError("A collection URL is required");
      return;
    }
    setImportFetching(true);
    setImportError(null);
    try {
      const data = await apiFetch(`${COLLECTION_API_BASE}/import/preview`, {
        method: "POST",
        body: {sourceUrl},
        errorMessage: "Unable to fetch that collection",
      });
      setImportPreview(data);
      // Seeded from the source's label through the same slugifier the Create
      // branch uses on every keystroke, and editable from here on — which is
      // what lets the curator fix a collision or a label with no ASCII in it.
      setImportForm({
        label: data.label || "",
        slug: suggestCollectionSlug(data.label || ""),
        slugEdited: false,
      });
      setStep("import-preview");
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportFetching(false);
    }
  };

  const handleImportConfirm = async (event) => {
    event.preventDefault();
    const problem = validateForm(importForm);
    if (problem) {
      setImportError(problem);
      return;
    }
    setImportConfirming(true);
    setImportError(null);
    try {
      const data = await apiFetch(`${COLLECTION_API_BASE}/import`, {
        method: "POST",
        body: {
          sourceUrl: importPreview.sourceUrl,
          label: importForm.label.trim(),
          slug: importForm.slug,
        },
        errorMessage: "Unable to import that collection",
      });
      if (Array.isArray(data.collections)) setCollections(data.collections);
      setError(null);
      setAdding(false);
      // Straight to the collection, where the progress banner lives and where
      // works appear as they land — mirroring the work import, which goes to the
      // work it just created. The collection already exists and is resolvable;
      // it is simply empty until the run fills it.
      navigate(`/collection/${encodeURIComponent(data.collection.slug)}`);
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportConfirming(false);
    }
  };

  const handleDelete = async (collection) => {
    try {
      const data = await apiFetch(`${COLLECTION_API_BASE}/${encodeURIComponent(collection.slug)}`, {
        method: "DELETE",
        errorMessage: "Unable to delete collection",
      });
      if (Array.isArray(data.collections)) setCollections(data.collections);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  // The collection of collections. The column counts WORKS, so the root's
  // figure is the total across every collection rather than the number of
  // collections — which is what its own `items` array holds.
  //
  // Summing is safe now: a work belongs to exactly one collection, so no work
  // is counted twice. It would not have been under the old many-to-many model.
  const rootRow = root?.id
    ? {
        label: root.label || "All Collections",
        slug: slugFromCollectionId(root.id) || "index",
        id: root.id,
        itemCount: collections.reduce((total, entry) => total + (entry.itemCount || 0), 0),
        thumbnail: null,
      }
    : null;

  return (
    <Flex direction="column" gap="5">
      <PageHeading>Collections</PageHeading>
      <Card size="3" className="panel">
        {isAdmin && (
          <Flex justify="end" align="center" gap="3" mb="4">
            <Button type="button" size="3" onClick={openModal} disabled={!available}>
              <PlusIcon /> Add
            </Button>
          </Flex>
        )}
        <Box className="panel-body">
          {!available && (
            <Callout.Root color="red" size="1" mb="3">
              <Callout.Text>
                Collection API URL is not configured. Update VITE_COLLECTION_API_URL to point at the
                deployed endpoint.
              </Callout.Text>
            </Callout.Root>
          )}
          {error && available && (
            <Callout.Root color="red" size="1" mb="3">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
          {loading ? (
            <Text as="p" size="2" color="gray">
              Loading collections…
            </Text>
          ) : !rootRow ? (
            <Text as="p" size="2" color="gray">
              No collections to show.
            </Text>
          ) : (
            <Table.Root size="2" variant="surface" className="manifest-list">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Collection</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Slug</Table.ColumnHeaderCell>
                  {/* "Items", not "Works": the root's members are collections. */}
                  <Table.ColumnHeaderCell>Works</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                <CollectionRow collection={rootRow} isRoot />
                {collections.map((collection) => (
                  <CollectionRow
                    key={collection.slug}
                    collection={collection}
                    // Only an empty collection can be deleted; the API refuses
                    // the rest rather than cascading over every member.
                    canDelete={isAdmin && !collection.itemCount}
                    onDelete={handleDelete}
                  />
                ))}
                {collections.length === 0 && (
                  <Table.Row>
                    <Table.Cell colSpan={4}>
                      <Text as="p" size="2" color="gray">
                        {noAccess
                          ? "You haven't been granted access to any collections. An administrator can grant you access from the Users section."
                          : isAdmin
                            ? "No collections yet. Use Add to create one."
                            : "No collections yet."}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Root>
          )}
        </Box>
      </Card>
      <AddCollectionModal
        open={adding}
        onClose={() => setAdding(false)}
        step={step}
        onSelectStep={setStep}
        onBack={handleModalBack}
        createForm={createForm}
        onCreateChange={(patch) => setCreateForm((prev) => ({...prev, ...patch}))}
        onCreateSubmit={handleCreateSubmit}
        createSubmitting={createSubmitting}
        createError={createError}
        importUrl={importUrl}
        onImportUrlChange={setImportUrl}
        onImportFetch={handleImportFetch}
        importFetching={importFetching}
        importError={importError}
        importPreview={importPreview}
        importForm={importForm}
        onImportFormChange={(patch) => setImportForm((prev) => ({...prev, ...patch}))}
        onImportConfirm={handleImportConfirm}
        importConfirming={importConfirming}
      />
    </Flex>
  );
}
