import { describe, expect, it } from "vitest";

import { canUseFreeSongRequest, isOpenSongRequestState } from "../../src/modules/song_requests/domain/rules";
import { songRequestsSettingsSchema } from "../../src/modules/song_requests/contracts";

describe("free song request role threshold", () => {
  it("allows everyone and rejects viewers below each configured threshold", () => {
    expect(canUseFreeSongRequest("everyone", ["viewer"])).toBe(true);
    expect(canUseFreeSongRequest("subscriber", ["viewer"])).toBe(false);
    expect(canUseFreeSongRequest("vip", ["subscriber"])).toBe(false);
    expect(canUseFreeSongRequest("moderator", ["vip"])).toBe(false);
  });

  it("accepts the selected role and every role above it", () => {
    expect(canUseFreeSongRequest("subscriber", ["subscriber"])).toBe(true);
    expect(canUseFreeSongRequest("subscriber", ["broadcaster"])).toBe(true);
    expect(canUseFreeSongRequest("vip", ["moderator"])).toBe(true);
    expect(canUseFreeSongRequest("moderator", ["moderator"])).toBe(true);
  });
});

describe("open song request states", () => {
  it("counts only requests that still occupy the current BroBot queue", () => {
    expect(["pending_review", "approved", "submitting", "submitted", "outcome_unknown"]
      .every((state) => isOpenSongRequestState(state))).toBe(true);
    expect(["observed_playing", "not_observed", "rejected", "removed", "failed"]
      .every((state) => !isOpenSongRequestState(state))).toBe(true);
  });
});

describe("song request settings", () => {
  it("defaults to paid live requests and keeps overlay row counts within the realtime bound", () => {
    const settings = songRequestsSettingsSchema.parse({});
    expect(settings.paymentMode).toBe("bot_points");
    expect(settings.alsoOffline).toBe(false);
    expect(settings.queueOverlayRows).toBeGreaterThanOrEqual(2);
    expect(settings.queueOverlayRows).toBeLessThanOrEqual(20);
  });

  it("rejects request caps outside server limits", () => {
    expect(songRequestsSettingsSchema.safeParse({ queueOverlayRows: 21 }).success).toBe(false);
    expect(songRequestsSettingsSchema.safeParse({ botPointsCost: 0 }).success).toBe(false);
  });
});
