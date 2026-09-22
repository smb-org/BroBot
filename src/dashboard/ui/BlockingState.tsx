import { colors } from "./theme";
import { Button } from "./Button";

export interface BlockingStateAction {
  label: string;
  onClick: () => void;
}

export interface BlockingStateProps {
  /** "error" reads as an outage (nothing works, installation-wide); "neutral"
   *  must not -- only this viewer/channel is affected, everything else still
   *  runs. Drives the same solid-vs-dashed distinction as `ErrorPanel` and
   *  `EmptyState`. */
  tone: "error" | "neutral";
  title: string;
  description: string;
  /** Omit when this viewer cannot fix it themselves -- pair with `contact`.
   *  An action the viewer cannot perform is worse than none (#159). */
  action?: BlockingStateAction;
  /** Who can fix it, shown instead of `action` when there is none. */
  contact?: string;
}

/**
 * Replaces page content for the two blocking states from #159 -- the bot
 * not being signed in (installation-wide) and a channel not being released
 * to this account (per user and channel) -- while navigation stays usable;
 * the caller only renders this in place of a page's normal content, never
 * around `Shell`. The caller decides which state applies, the copy, and
 * whether this viewer gets the action or the contact line; this component
 * only lays the card out.
 */
export function BlockingState({ tone, title, description, action, contact }: BlockingStateProps) {
  const border = tone === "error"
    ? `1px solid color-mix(in srgb, ${colors.error} 45%, ${colors.hairline})`
    : `1px dashed ${colors.hairlineStrong}`;
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "64px 16px" }}>
      <div
        style={{
          width: "min(30rem, 100%)",
          padding: "32px 28px",
          textAlign: "center",
          border,
          borderRadius: "12px",
          background: colors.surface,
        }}
      >
        <h1 style={{ margin: "0 0 12px", fontSize: "22px", color: tone === "error" ? colors.error : colors.text }}>{title}</h1>
        <p style={{ margin: 0, fontSize: "13px", color: colors.text2 }}>{description}</p>
        {action !== undefined ? (
          <div style={{ marginTop: "20px" }}>
            <Button variant="primary" onClick={action.onClick}>{action.label}</Button>
          </div>
        ) : contact !== undefined ? (
          <p style={{ margin: "16px 0 0", fontSize: "12px", color: colors.text3 }}>{contact}</p>
        ) : null}
      </div>
    </div>
  );
}
