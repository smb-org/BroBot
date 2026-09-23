import { colors } from "./theme";
import { Button } from "./Button";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  title: string;
  description: string;
  /** "The primary action for managers" -- omit for an operator, who gets
   *  the same explanation without a call to action. */
  action?: EmptyStateAction;
}

/**
 * "Empty and error box" in the dashboard design document: dashed strong line
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
