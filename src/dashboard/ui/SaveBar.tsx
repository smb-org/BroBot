import { colors } from "./theme";
import { Button } from "./Button";

export interface SaveBarProps {
  /** Visible only while the draft differs from the saved value. */
  dirty: boolean;
  pending?: boolean;
  error?: string;
  /** "Gespeichert", shown once after a successful save until the next edit;
   *  the caller clears it on the next change, not on a timer. */
  saved?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel: string;
  discardLabel: string;
  savedLabel: string;
  pendingLabel: string;
}

/**
 * "Speichern-Leiste (`SaveBar`)" in docs/input/DESIGN-neu.md: sits at the
 * inspector's foot, appears once the draft is dirty, disappears again once
 * it is not (except for the one-shot "Gespeichert" confirmation, which has
 * no timer and clears only on the next edit).
 */
export function SaveBar({
  dirty,
  pending = false,
  error,
  saved = false,
  onSave,
  onDiscard,
  saveLabel,
  discardLabel,
  savedLabel,
  pendingLabel,
}: SaveBarProps) {
  if (!dirty && !saved) {
    return null;
  }

  const statusText = error ? `× ${error}` : pending ? pendingLabel : saved && !dirty ? savedLabel : undefined;

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
      <span role="status" aria-live="polite" style={{ fontSize: "12px", color: error ? colors.errorText : colors.text3 }}>
        {statusText}
      </span>
      {dirty ? (
        <div style={{ display: "flex", gap: "8px" }}>
          <Button variant="subtle" onClick={onDiscard} disabled={pending}>
            {discardLabel}
          </Button>
          <Button variant="primary" onClick={onSave} disabled={pending}>
            {saveLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
