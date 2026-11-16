import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import SongRequestQueueOverlay from "../../src/modules/song_requests/overlay/queue-view";
import { buildSongRequestQueueState } from "../../src/modules/song_requests/domain/queue-state";

const rows = (count: number) => Array.from({ length: count }, (_value, index) => ({
  title: `Fictional track ${String(index)}`,
  requester: `viewer_${String(index)}`,
  requestType: index % 2 === 0 ? "bot_points" as const : "free" as const,
}));

afterEach(cleanup);

describe("song request queue overlay layout", () => {
  it.each([{ rowCount: 2, height: "146px" }, { rowCount: 20, height: "902px" }])(
    "reserves all $rowCount row slots at a fixed height",
    ({ rowCount, height }) => {
      const component = render(<SongRequestQueueOverlay state={{ ...buildSongRequestQueueState({ revision: 1, rowCount, rows: rows(rowCount) }) }} config={{}} now={Date.parse("2026-11-15T12:00:00.000Z")} language="en" />);
      const overlay = component.getByTestId("song-request-queue-overlay");
      expect(overlay.style.height).toBe(height);
      expect(overlay.querySelectorAll(".song-request-queue-overlay__row")).toHaveLength(rowCount);
      expect(overlay.style.getPropertyValue("--song-request-row-count")).toBe(String(rowCount));
    },
  );
});
