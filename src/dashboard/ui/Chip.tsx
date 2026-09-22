import { useMantineTheme } from "@mantine/core";
import type { CSSProperties } from "react";

import { colors } from "./theme";

export type ChipTone = "community" | "raid" | "moderation" | "green" | "amber" | "red" | "neutral";

export interface ChipProps {
  /** Event family, status color for operational events, or `neutral` for
   *  number chips and unknown events. */
  tone: ChipTone;
  /** Apply the family fill when true; otherwise keep the chip outlined.
   *  Ignored for `neutral`. */
  filled?: boolean;
  /** The number chip: Plex Mono with tabular numerals, no tone coloring. */
  mono?: boolean;
  children: string;
}

/**
 * Event chips are 20px tall with a 1px border and small radius. Family and
 * status colors come from `theme.other`, as specified in the design document.
 */
export function Chip({ tone, filled, mono, children }: ChipProps) {
  const theme = useMantineTheme();
  const { state, family } = theme.other;

  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    height: "20px",
    padding: "0 8px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 600,
    lineHeight: 1,
  };

  if (mono) {
    return (
      <span
        style={{
          ...base,
          fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
          fontVariantNumeric: "tabular-nums",
          fontWeight: 400,
          color: colors.text,
          backgroundColor: colors.well,
          border: `1px solid ${colors.hairline}`,
        }}
      >
        {children}
      </span>
    );
  }

  if (tone === "neutral") {
    return (
      <span style={{ ...base, color: colors.text2, border: `1px solid ${colors.hairlineStrong}` }}>{children}</span>
    );
  }

  const token = tone === "green" || tone === "amber" || tone === "red" ? state[tone] : family[tone];
  const border = `color-mix(in srgb, ${token.color} 45%, ${colors.hairline})`;

  return (
    <span
      style={{
        ...base,
        color: token.color,
        border: `1px solid ${border}`,
        backgroundColor: filled && token.background ? token.background : "transparent",
      }}
    >
      {children}
    </span>
  );
}
