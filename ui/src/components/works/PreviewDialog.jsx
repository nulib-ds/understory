import {Box, Dialog} from "@radix-ui/themes";
import CloverViewer from "../CloverViewer";
import {CLOVER_OPTIONS, CLOVER_THEME} from "../../cloverTheme";

// Clover in a modal. Keyed on the work so opening a different row rebuilds the
// vault rather than reusing the previous work's.
export default function PreviewDialog({work, onClose}) {
  return (
    <Dialog.Root open={Boolean(work)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="calc(800 * var(--px))">
        <Dialog.Title>{work?.label || work?.identifier}</Dialog.Title>
        {work && (
          <Box className="viewer-stage" style={{width: "100%"}}>
            <CloverViewer
              key={work.identifier}
              iiifContent={work.manifestUrl}
              customTheme={CLOVER_THEME}
              options={CLOVER_OPTIONS}
            />
          </Box>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
