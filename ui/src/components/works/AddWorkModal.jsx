import {useState} from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  Select,
  Text,
  TextField,
} from "@radix-ui/themes";
import {ZoomInIcon} from "@radix-ui/react-icons";
import CloverViewer from "../CloverViewer";
import {CLOVER_OPTIONS, CLOVER_THEME} from "../../cloverTheme";

export default function AddWorkModal({
  open,
  onClose,
  step,
  onSelectStep,
  onBack,
  createForm,
  onCreateChange,
  onCreateSubmit,
  createSubmitting,
  createError,
  importUrl,
  onImportUrlChange,
  onImportFetch,
  importFetching,
  importError,
  importPreview,
  onImportConfirm,
  importConfirming,
}) {
  const [showImportViewer, setShowImportViewer] = useState(false);
  const [importViewerContent, setImportViewerContent] = useState(null);

  const handleCreateChange = (evt) => {
    onCreateChange(evt.target.name, evt.target.value);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Content maxWidth="calc(560 * var(--px))">
        {step === "choose" && (
          <>
            <Dialog.Title>Add Work</Dialog.Title>
            <Flex direction="column" gap="3">
              <Card asChild variant="surface" className="add-work-option">
                <button type="button" onClick={() => onSelectStep("import-url")}>
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Import Works</Text>
                    <Text size="2" color="gray">Bring in an existing IIIF Manifest.</Text>
                  </Flex>
                </button>
              </Card>
              <Card variant="surface">
                <Flex justify="between" align="center">
                  <Flex direction="column" gap="1">
                    <Text weight="medium" color="gray">Upload Works</Text>
                    <Text size="2" color="gray">Upload your own image files.</Text>
                  </Flex>
                  <Badge color="gray">Coming soon</Badge>
                </Flex>
              </Card>
              <Card asChild variant="surface" className="add-work-option">
                <button type="button" onClick={() => onSelectStep("create")}>
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Create Work</Text>
                    <Text size="2" color="gray">Manually create a new, empty work.</Text>
                  </Flex>
                </button>
              </Card>
              <Flex justify="end" mt="2">
                <Button type="button" variant="soft" color="gray" onClick={onClose}>
                  Cancel
                </Button>
              </Flex>
            </Flex>
          </>
        )}

        {step === "create" && (
          <>
            <Dialog.Title>Create Work</Dialog.Title>
            <form onSubmit={onCreateSubmit}>
              <Flex direction="column" gap="3">
                <label>
                  <Text as="div" size="2" weight="medium" mb="1">Title</Text>
                  <TextField.Root
                    name="label"
                    type="text"
                    required
                    value={createForm.label}
                    onChange={handleCreateChange}
                    placeholder="e.g. 1973 yearbook"
                  />
                </label>
                {createError && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{createError}</Callout.Text>
                  </Callout.Root>
                )}
                <Flex justify="between" gap="3" mt="2">
                  <Button type="button" variant="ghost" onClick={onBack} disabled={createSubmitting}>
                    ← Back
                  </Button>
                  <Flex gap="3">
                    <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={createSubmitting}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={createSubmitting}>
                      Create
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </form>
          </>
        )}

        {step === "import-url" && (
          <>
            <Dialog.Title>Import Work</Dialog.Title>
            <form onSubmit={onImportFetch}>
              <Flex direction="column" gap="3">
                <label>
                  <Text as="div" size="2" weight="medium" mb="1">Manifest URL</Text>
                  <TextField.Root
                    type="url"
                    required
                    value={importUrl}
                    onChange={(evt) => onImportUrlChange(evt.target.value)}
                    placeholder="https://example.org/iiif/manifest.json"
                  />
                </label>
                {importError && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{importError}</Callout.Text>
                  </Callout.Root>
                )}
                <Flex justify="between" gap="3" mt="2">
                  <Button type="button" variant="ghost" onClick={onBack} disabled={importFetching}>
                    ← Back
                  </Button>
                  <Flex gap="3">
                    <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={importFetching}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={importFetching}>
                      Fetch
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </form>
          </>
        )}

        {step === "import-preview" && (
          <>
            <Dialog.Title>Confirm Import</Dialog.Title>
            <Flex direction="column" gap="3">
              <Card variant="surface">
                <Flex gap="3" align="center">
                  <button
                    type="button"
                    className="import-preview-thumbnail"
                    onClick={() => {
                      // Clover mutates the manifest object it's given, so hand it a
                      // disposable clone — the original must stay intact for Import.
                      setImportViewerContent(structuredClone(importPreview.manifest));
                      setShowImportViewer(true);
                    }}
                    aria-label="Preview manifest"
                  >
                    {importPreview?.thumbnail ? (
                      <img
                        src={`${importPreview.thumbnail.replace(/\/$/, "")}/full/,128/0/default.jpg`}
                        alt=""
                        onError={(evt) => {
                          evt.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      <Text size="1" color="gray">Preview</Text>
                    )}
                    <span className="import-preview-thumbnail__zoom">
                      <ZoomInIcon />
                    </span>
                  </button>
                  <Flex direction="column" gap="1" style={{flex: 1, minWidth: 0}}>
                    <Text weight="medium">{importPreview?.label || "(untitled)"}</Text>
                    <Text size="2" color="gray">
                      {importPreview?.itemCount ?? 0} canvas{importPreview?.itemCount === 1 ? "" : "es"}
                      {importPreview?.av?.copied > 0 &&
                        ` · ${importPreview.av.copied} audio/video, copied as-is`}
                    </Text>
                    <Text size="1" color="gray" style={{wordBreak: "break-all"}}>
                      {importPreview?.sourceUrl}
                    </Text>
                  </Flex>
                </Flex>
              </Card>
              {/* Said before Import is pressed, not discovered afterwards: these
                  canvases are left out of the work entirely (see avImport.js). */}
              {importPreview?.skipped?.length > 0 && (
                <Callout.Root color="amber" size="1">
                  <Callout.Text>
                    {importPreview.skipped.length} audio/video canvas
                    {importPreview.skipped.length === 1 ? " won't" : "es won't"} be imported:
                  </Callout.Text>
                  <ul className="import-skipped-list">
                    {importPreview.skipped.map((entry) => (
                      <li key={entry.index}>
                        <Text size="1">
                          {entry.label} — {entry.reason}
                        </Text>
                      </li>
                    ))}
                  </ul>
                </Callout.Root>
              )}
              {importError && (
                <Callout.Root color="red" size="1">
                  <Callout.Text>{importError}</Callout.Text>
                </Callout.Root>
              )}
              <Flex justify="between" gap="3" mt="2">
                <Button type="button" variant="ghost" onClick={onBack} disabled={importConfirming}>
                  ← Back
                </Button>
                <Flex gap="3">
                  <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={importConfirming}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={onImportConfirm} loading={importConfirming}>
                    Import
                  </Button>
                </Flex>
              </Flex>
            </Flex>
            <Dialog.Root open={showImportViewer} onOpenChange={setShowImportViewer}>
              <Dialog.Content maxWidth="calc(800 * var(--px))">
                <Flex justify="between" align="center" mb="2">
                  <Dialog.Title mb="0">{importPreview?.label || "Preview"}</Dialog.Title>
                  <Button type="button" variant="ghost" onClick={() => setShowImportViewer(false)}>
                    ← Back
                  </Button>
                </Flex>
                {importViewerContent && (
                  <Box className="viewer-stage" style={{width: "100%"}}>
                    <CloverViewer
                      key={importPreview?.sourceUrl}
                      iiifContent={importViewerContent}
                      customTheme={CLOVER_THEME}
                      options={CLOVER_OPTIONS}
                    />
                  </Box>
                )}
              </Dialog.Content>
            </Dialog.Root>
          </>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

