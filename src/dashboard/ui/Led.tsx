import { useMantineTheme } from "@mantine/core";

import { colors } from "./theme";

export type LedStatus = "green" | "amber" | "red" | "off";

export interface LedProps {
  status: LedStatus;
  /** "Green never stands without a word next to it" -- there is no
   *  optional-word escape hatch here on purpose. */
  word: string;
}

/**
 * "The LED-with-word rule": color alone never carries state. Mantine's
 * `Badge`/`Indicator` are deliberately not used -- see "LED" in
 * docs/input/DESIGN-neu.md. Reads its colors from `theme.other.state`
 * ("theme.other.zustand" in the document), as the document specifies.
 */
export function Led({ status, word }: LedProps) {
  const theme = useMantineTheme();
  const { state } = theme.other;

  const dotColor = status === "off" ? colors.well : state[status].color;
  const dotBorder = status === "off" ? `1px solid ${state.off.color}` : "none";
  const wordColor = status === "off" ? colors.text3 : status === "red" ? (state.red.wordColor ?? state.red.color) : state[status].color;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "7px", minHeight: "20px" }}>
      <span
        aria-hidden="true"
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          backgroundColor: dotColor,
          border: dotBorder,
          transition: "background-color 160ms ease, border-color 160ms ease",
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: "12px", fontWeight: 600, color: wordColor, transition: "color 160ms ease" }}>{word}</span>
    </span>
  );
}
