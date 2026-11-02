import { afterEach, describe, expect, it, vi } from "vitest";

import { loadTempVipActionReadiness, tempVipManagedActionsAvailable } from "../../src/modules/temp_vips/panel/service";
import { broadcasterTokenHasScope } from "../../src/worker/broadcaster-scope";
import { getPanelModuleDataForChannels } from "../../src/worker/panel/module-repository";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("temporary VIP panel readiness after a narrower broadcaster login", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps historical optional consent in panel metadata while disabling managed actions from current mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        `INSERT INTO twitch_login_identity
          (user_id, login, scopes_json, token_scopes_json, access_token_ciphertext,
           refresh_token_ciphertext, expires_at, status, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'fictional_access', 'fictional_refresh', ?, 'connected', NULL, ?, ?)`,
      ).bind(
        "kanal-a",
        "kanal-a",
        '["channel:manage:vips"]',
        "[]",
        "2099-11-01T12:00:00.000Z",
        "2026-11-01T12:00:00.000Z",
        "2026-11-01T12:00:00.000Z",
      ).run();

      const { states } = await getPanelModuleDataForChannels(database as unknown as D1Database, ["kanal-a"]);
      const tempVipMetadata = states.get("kanal-a")?.find(({ id }) => id === "temp_vips");
      expect(tempVipMetadata).toMatchObject({
        optionalBroadcasterScopes: ["channel:manage:vips"],
        missingOptionalBroadcasterScopes: [],
      });
      const currentTokenCanManageVips = await broadcasterTokenHasScope(
        database as unknown as D1Database,
        "kanal-a",
        "channel:manage:vips",
      );
      expect(currentTokenCanManageVips).toBe(false);
      const currentMode = currentTokenCanManageVips ? "managed" : "observe";

      const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/modules/temp_vips/vips")) {
          return Promise.resolve(new Response(JSON.stringify({ mode: currentMode }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({
          modules: [{ id: "temp_vips", missingOptionalBroadcasterScopes: tempVipMetadata?.missingOptionalBroadcasterScopes ?? [] }],
        }), { status: 200 }));
      });
      vi.stubGlobal("fetch", fetcher);

      await expect(loadTempVipActionReadiness("kanal-a")).resolves.toEqual({
        ready: false,
        missingScopes: ["channel:manage:vips"],
        metadataUnknown: false,
      });
      expect(tempVipManagedActionsAvailable(currentMode)).toBe(false);
      expect(fetcher.mock.calls[0]?.[0]).toBe("/api/channels/kanal-a/modules/temp_vips/vips");
    } finally {
      database.close();
    }
  });
});
