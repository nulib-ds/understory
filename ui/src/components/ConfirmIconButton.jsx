import {useState} from "react";
import {Button, IconButton, Tooltip} from "@radix-ui/themes";

// An icon button for something that cannot be taken back with a click — clearing
// a value, removing a field — that asks first. Two clicks: the first arms it,
// turning it into a red "<label>?" button in the same place, and the second
// does it. Clicking anywhere else, or Escape, disarms it, so a stray click
// never does more than arm.
//
// The armed button takes the focus, so a keyboard user confirms with the same
// key that armed it.
export default function ConfirmIconButton({
  label,
  icon,
  onConfirm,
  size = "1",
  color = "gray",
  variant = "soft",
  disabled = false,
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (armed) {
    return (
      <Button
        type="button"
        size={size}
        variant="soft"
        color="red"
        autoFocus
        loading={busy}
        disabled={disabled}
        onBlur={() => {
          if (!busy) setArmed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setArmed(false);
          }
        }}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setArmed(false);
          }
        }}
      >
        {label}?
      </Button>
    );
  }

  return (
    <Tooltip content={label}>
      <IconButton
        type="button"
        size={size}
        variant={variant}
        color={color}
        aria-label={label}
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );
}
