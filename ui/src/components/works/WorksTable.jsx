import {useState} from "react";
import {Link as RouterLink} from "react-router-dom";
import {Button, Callout, Flex, Link, Table, Text} from "@radix-ui/themes";
import PreviewDialog from "./PreviewDialog";
import DeleteWorkDialog from "./DeleteWorkDialog";
import SyncStateBadge from "./SyncStateBadge";
import {imageRequestUrl} from "../../lib/canvasAssets";

// When the filter hides every row the table must still render its header, or
// the control disappears along with the rows and there is no way to undo it.
// (This guarded the collection filter before; the `q` filter has exactly the
// same problem.)
function EmptyFilterRow({colSpan, children}) {
  return (
    <Table.Row>
      <Table.Cell colSpan={colSpan}>
        <Text as="p" size="2" color="gray">
          {children}
        </Text>
      </Table.Cell>
    </Table.Row>
  );
}

function hideOnError(event) {
  event.currentTarget.style.visibility = "hidden";
}

// One representative image, squared. `square` region with an explicit w,h is
// level-2 Image API and reads the same in 2.x and 3.x, so every row is an
// identical square whatever the source aspect ratio — the same treatment the
// collections list and the sign-in showcase use.
//
// Requested at 2x the rendered size so it stays sharp on a retina display.
// A work with no image — an audio work, or one mid-import — keeps the empty
// box, which holds the column's width so the titles beside it stay aligned.
function WorkThumbnail({work}) {
  const service = Array.isArray(work.thumbnails) ? work.thumbnails[0] : null;
  return (
    <span className="work-thumb">
      {service && (
        <img
          src={imageRequestUrl(service, {region: "square", size: "64,64"})}
          alt=""
          loading="lazy"
          onError={hideOnError}
        />
      )}
    </span>
  );
}

function canvasCountOf(work) {
  if (Number.isFinite(work.itemCount)) return work.itemCount;
  return Array.isArray(work.manifest?.items) ? work.manifest.items.length : 0;
}

// One table for the whole collection, filtered or not. There used to be two —
// a list and a separate search-results table — because listing and searching
// were different endpoints returning different shapes. They are one query now,
// so a filtered view is the same table with fewer rows.
//
// There is no Collection column: every row here is in the same collection.
export default function WorksTable({works, onDelete, workPath, filtered, loading, error}) {
  const [previewWork, setPreviewWork] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  if (loading) {
    return <Text as="p" size="2" color="gray">Loading works…</Text>;
  }

  if (error) {
    return (
      <Callout.Root color="red" size="1">
        <Callout.Text>{error}</Callout.Text>
      </Callout.Root>
    );
  }

  const rows = works || [];
  // Only a genuinely empty collection skips the table; a filtered-empty one
  // keeps its header so the filter can be cleared.
  if (rows.length === 0 && !filtered) {
    return <Text as="p" size="2" color="gray" className="tree-empty">No works in this collection yet.</Text>;
  }

  return (
    <>
      <Table.Root variant="ghost" className="manifest-list">
        <Table.Header>
          <Table.Row>
            {/* Deliberately unlabelled: a heading over a 32px image says
                nothing the image does not, and the column is too narrow for
                one without forcing the title column over. */}
            <Table.ColumnHeaderCell className="work-thumb-cell" />
            <Table.ColumnHeaderCell className="work-title-cell">Title</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Assets</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell></Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.length === 0 && (
            <EmptyFilterRow colSpan={5}>No works match that filter.</EmptyFilterRow>
          )}
          {rows.map((work) => (
            <Table.Row key={work.identifier} className="manifest-list-row">
              <Table.Cell className="work-thumb-cell">
                <WorkThumbnail work={work} />
              </Table.Cell>
              <Table.RowHeaderCell className="work-title-cell">
                <Link asChild size="2" weight="bold">
                  <RouterLink to={workPath(work.identifier)}>
                    {work.label || work.identifier}
                  </RouterLink>
                </Link>
              </Table.RowHeaderCell>
              <Table.Cell className="assets-cell">
                <Text size="2">{canvasCountOf(work)}</Text>
              </Table.Cell>
              {/* Always visible, unlike the actions cell, which is hidden until
                  hover — a status you have to hover to see is not a status. */}
              <Table.Cell>
                <SyncStateBadge state={work.syncState} />
              </Table.Cell>
              <Table.Cell>
                <Flex gap="3" justify="end" className="manifest-row-actions">
                  <Link asChild size="2">
                    <RouterLink to={workPath(work.identifier)}>Edit</RouterLink>
                  </Link>
                  <Button variant="ghost" size="2" onClick={() => setPreviewWork(work)}>
                    Preview
                  </Button>
                  <Link asChild size="2">
                    <a href={work.manifestUrl} target="_blank" rel="noreferrer">
                      IIIF
                    </a>
                  </Link>
                  <Button
                    variant="ghost"
                    size="2"
                    color="red"
                    onClick={() => setPendingDelete(work)}
                  >
                    Delete
                  </Button>
                </Flex>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <PreviewDialog work={previewWork} onClose={() => setPreviewWork(null)} />
      <DeleteWorkDialog
        work={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async (identifier) => {
          await onDelete(identifier);
          setPendingDelete(null);
        }}
      />
    </>
  );
}
