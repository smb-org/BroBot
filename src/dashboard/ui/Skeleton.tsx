import { Skeleton as MantineSkeleton } from "@mantine/core";

import { colors } from "./theme";

export interface SkeletonProps {
  /** How many rows to stand in for. @default 1 */
  rows?: number;
  /** Row height in px -- 34 for a table row, 58 for a status row, and so
   *  on: "in the height ... of the rows that come." */
  height: number;
}

/**
 * "The stale rule" in docs/input/DESIGN-neu.md: a skeleton only stands
 * in for the *first* load with no data yet -- reloads keep the stale
 * values at 55% opacity instead (that rule belongs to the caller, not this
 * component). No shimmer, ever: movement in the corner of the eye reads as
 * a change next to a running stream.
 */
export function Skeleton({ rows = 1, height }: SkeletonProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {Array.from({ length: rows }, (_, index) => (
        <MantineSkeleton key={index} height={height} radius="sm" animate={false} styles={{ root: { backgroundColor: colors.well } }} />
      ))}
    </div>
  );
}
