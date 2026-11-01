import { describe, expect, it } from "vitest";

import {
  mapVipCallFailure,
  mapVipHttpStatus,
} from "../../src/worker/twitch/vips";

describe("temporary VIP Helix outcomes", () => {
  it.each([
    ["add", 204, null, "success"],
    ["add", 409, null, "no_slots"],
    ["add", 422, "That user is already a VIP", "already_vip"],
    ["add", 422, "That user is a moderator", "moderator"],
    ["add", 425, null, "community_gate"],
    ["add", 429, null, "rate_limited"],
    ["remove", 404, null, "not_vip"],
    ["remove", 204, null, "success"],
    ["add", 418, null, "unknown_status"],
  ] as const)("maps %s status %i to %s", (operation, status, message, expected) => {
    expect(mapVipHttpStatus(operation, status, message).reason).toBe(expected);
  });

  it("keeps network and unknown HTTP outcomes distinguishable for grant recovery", () => {
    expect(mapVipHttpStatus("add", null, null, "timeout")).toMatchObject({ reason: "network", ambiguous: true });
    expect(mapVipHttpStatus("add", 503, null).ambiguous).toBe(true);
    expect(mapVipHttpStatus("add", 429, null).ambiguous).toBe(false);
  });

  it.each([
    ["not_connected", "not_connected"],
    ["token_unavailable", "token_unavailable"],
    ["scope_missing", "scope_missing"],
    ["revoked", "revoked"],
    ["refresh_failed", "refresh_failed"],
    ["request_failed", "network"],
    ["precondition_failed", "precondition_failed"],
  ] as const)("maps withBroadcasterToken kind %s", (kind, reason) => {
    expect(mapVipCallFailure({ kind } as never)).toMatchObject({ ok: false, reason });
  });
});
