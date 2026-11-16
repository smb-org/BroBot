import { describe, expect, it } from "vitest";

import { buildSongRequestQueueState } from "../../src/modules/song_requests/domain/queue-state";

const queueRows = (count: number) => Array.from({ length: count }, (_value, index) => ({
  title: `Fictional track ${String(index)} 🎵`.repeat(8),
  requester: `Viewer ${String(index)} 🎧`.repeat(5),
  requestType: index % 2 === 0 ? "bot_points" as const : "free" as const,
}));

describe("song request queue overlay state", () => {
  it("keeps two configured row slots and produces a compact state", () => {
    const state = buildSongRequestQueueState({ revision: 4, rowCount: 2, rows: queueRows(8) });
    expect(state.rowCount).toBe(2);
    expect(state.rows.length).toBe(2);
  });

  it("limits twenty row payloads below the 4 KB realtime message bound", () => {
    const state = buildSongRequestQueueState({ revision: 8, rowCount: 20, rows: queueRows(24) });
    expect(state.rows.length).toBeLessThanOrEqual(20);
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeLessThan(4_096);
  });
});
