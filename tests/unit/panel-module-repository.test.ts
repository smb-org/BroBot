import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPanelModuleDataForChannels } from "../../src/worker/panel/module-repository";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

// A mandatory module (text_library, channel_events) has no `channel_modules`
// row for channels that predate it -- there is no backfill migration, by
// design (see selectModulesForEvent in worker/dispatch.ts, which applies the
// same rule). Both the module list and the active-module list must still
// report it as active, or its panel never mounts (issue behind this test).
describe("getPanelModuleDataForChannels: mandatory modules without a row", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
  });

  it("lists mandatory modules as active with no channel_modules row at all", async () => {
    await insertChannel(database, "kanal-a");

    const { states, active } = await getPanelModuleDataForChannels(database as unknown as D1Database, ["kanal-a"]);

    const channelStates = states.get("kanal-a") ?? [];
    const channelActive = active.get("kanal-a") ?? [];

    expect(channelStates.find((module) => module.id === "text_library")).toMatchObject({ enabled: true, mandatory: true });
    expect(channelStates.find((module) => module.id === "channel_events")).toMatchObject({ enabled: true, mandatory: true });
    expect(channelActive.map((module) => module.moduleId)).toEqual(
      expect.arrayContaining(["text_library", "channel_events"]),
    );

    // Non-mandatory modules stay off without a row.
    expect(channelStates.find((module) => module.id === "clips")).toMatchObject({ enabled: false, mandatory: false });
    expect(channelActive.map((module) => module.moduleId)).not.toContain("clips");
  });

  it("keeps a mandatory module active even if its stored row is disabled, using its stored settings", async () => {
    await insertChannel(database, "kanal-a");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'text_library', 0, '{"foo":1}')`,
    ).run();

    const { active } = await getPanelModuleDataForChannels(database as unknown as D1Database, ["kanal-a"]);

    expect(active.get("kanal-a")).toEqual(
      expect.arrayContaining([{ moduleId: "text_library", settings: '{"foo":1}' }]),
    );
  });

  it("does not duplicate a mandatory module that already has an enabled row", async () => {
    await insertChannel(database, "kanal-a");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'text_library', 1, '{}')`,
    ).run();

    const { active } = await getPanelModuleDataForChannels(database as unknown as D1Database, ["kanal-a"]);

    expect(active.get("kanal-a")?.filter((module) => module.moduleId === "text_library")).toHaveLength(1);
  });
});
