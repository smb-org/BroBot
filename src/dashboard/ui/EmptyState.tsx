import { colors } from "./theme";
import { Button } from "./Button";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  title: string;
  description: string;
  /** "für Verwalter die primäre Handlung" -- omit for a Bediener, who gets
   *  the same explanation without a call to action. */
  action?: EmptyStateAction;
}

/**
 * "Leer- und Fehlerkasten" in docs/input/DESIGN-neu.md: dashed Linie-Stark
 * border, radius md, Text-2 body.
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div
      style={{
        border: `1px dashed ${colors.hairlineStrong}`,
        borderRadius: "12px",
        padding: "20px 18px",
        color: colors.text2,
      }}
    >
      <div style={{ fontSize: "15px", fontWeight: 600, color: colors.text, marginBottom: "4px" }}>{title}</div>
      <p style={{ fontSize: "13px", margin: 0 }}>{description}</p>
      {action ? (
        <div style={{ marginTop: "12px" }}>
          <Button variant="primary" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
