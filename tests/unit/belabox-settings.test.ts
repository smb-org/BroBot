import { describe, expect, it } from "vitest";

import {
  BELABOX_DEFAULT_SETTINGS,
  belaboxSettingsSchema,
} from "../../src/modules/belabox/contracts";
import { belaboxDefaultAlertTexts } from "../../src/modules/belabox/contracts/alert-texts";
import { belaboxAlertDefaultsOnEnable } from "../../src/modules/belabox/service";
import { authorizeModuleManagementMutation } from "../../src/worker/module-authorization";
import { insertChannel, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("BELABOX alert settings", () => {
  it("provides valid alert and chat defaults alongside the current polling interval", () => {
    expect(BELABOX_DEFAULT_SETTINGS).toMatchObject({
      mode: "interval",
      intervalSeconds: 15,
      alertsEnabled: true,
      lowBitrateKbps: 1_000,
      recoverBitrateKbps: 2_000,
      holdSeconds: 15,
      recoverHoldSeconds: 15,
      chatCooldownSeconds: 300,
      chatEnabled: false,
      lowTarget: "source_only",
      disconnectTarget: "source_only",
      recoveryTarget: "source_only",
    });
    expect(belaboxSettingsSchema.safeParse(BELABOX_DEFAULT_SETTINGS).success).toBe(true);
    expect(belaboxSettingsSchema.parse({ mode: "interval", intervalSeconds: 5 })).toMatchObject({
      holdSeconds: 10,
      recoverHoldSeconds: 15,
    });
    expect(belaboxDefaultAlertTexts("de").lowText).toContain("{belabox.bitrate}");
    expect(belaboxDefaultAlertTexts("en").recoveryText).toContain("{belabox.down_for}");
  });

  it("rejects a recovery threshold that does not exceed the low threshold", () => {
    const result = belaboxSettingsSchema.safeParse({
      ...BELABOX_DEFAULT_SETTINGS,
      recoverBitrateKbps: 1_000,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["recoverBitrateKbps"]);
  });

  it("rejects hold times shorter than the configured polling interval", () => {
    const result = belaboxSettingsSchema.safeParse({
      ...BELABOX_DEFAULT_SETTINGS,
      intervalSeconds: 30,
      holdSeconds: 10,
      recoverHoldSeconds: 15,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["holdSeconds"]);
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["recoverHoldSeconds"]);
    }
  });

  it("bounds each alert message to the host chat limit", () => {
    const result = belaboxSettingsSchema.safeParse({
      ...BELABOX_DEFAULT_SETTINGS,
      lowText: "x".repeat(501),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["lowText"]);
  });

  it("writes fresh low, disconnect, and recovery defaults using the channel language on enable", async () => {
    const database = new TestD1Database();
    try {
      for (const [channelId, language] of [["belabox-de", "de"], ["belabox-en", "en"]] as const) {
        await insertChannel(database, channelId);
        await database.prepare("UPDATE channels SET language = ? WHERE channel_id = ?").bind(language, channelId).run();
        await insertMember(database, channelId, "manager", "manager");
        await database.prepare(
          "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
        ).bind(channelId, JSON.stringify(BELABOX_DEFAULT_SETTINGS)).run();
        const statements = await belaboxAlertDefaultsOnEnable({
          DB: database as unknown as D1Database,
          authorizeMutation: authorizeModuleManagementMutation,
          actor: { userId: "manager" },
          now: "2026-10-05T12:00:00.000Z",
        }, channelId);
        for (const statement of statements) await statement.run();
        const row = await database.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'")
          .bind(channelId).first<{ settings: string }>();
        const saved = JSON.parse(row?.settings ?? "{}") as Record<string, unknown>;
        expect(saved.lowText).toBe(belaboxDefaultAlertTexts(language).lowText);
        expect(saved.disconnectText).toBe(belaboxDefaultAlertTexts(language).disconnectText);
        expect(saved.recoveryText).toBe(belaboxDefaultAlertTexts(language).recoveryText);
      }
    } finally {
      database.close();
    }
  });
});
