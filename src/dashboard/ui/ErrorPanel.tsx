import { colors } from "./theme";
import { Button } from "./Button";

export interface ErrorPanelAction {
  label: string;
  onClick: () => void;
}

export interface ErrorPanelProps {
  /** What didn't work. */
  title: string;
  /** Why. */
  reason: string;
  /** The next possible action -- "always three things: what didn't work,
   *  why, and the next possible action", so this is not optional. */
  action: ErrorPanelAction;
}

/**
 * "Empty and error box" in docs/input/DESIGN-neu.md: solid border,
 * 45%-red on Fehler-Grund, title in red.
 */
export function ErrorPanel({ title, reason, action }: ErrorPanelProps) {
  return (
    <div
      style={{
        border: `1px solid color-mix(in srgb, ${colors.error} 45%, ${colors.hairline})`,
        backgroundColor: colors.errorFill,
        borderRadius: "12px",
        padding: "20px 18px",
      }}
    >
      <div style={{ fontSize: "15px", fontWeight: 600, color: colors.error, marginBottom: "4px" }}>{title}</div>
      <p style={{ fontSize: "13px", color: colors.text2, margin: 0 }}>{reason}</p>
      <div style={{ marginTop: "12px" }}>
        <Button variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      </div>
    </div>
  );
}
