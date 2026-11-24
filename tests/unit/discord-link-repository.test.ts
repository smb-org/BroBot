import { afterEach, describe, expect, it } from "vitest";

import { getDiscordLink, removeDiscordLink, replaceDiscordLink, type DiscordLink } from "../../src/modules/discord/repository";
import { TestD1Database } from "./test-d1";

const databases: TestD1Database[] = [];
const createDatabase = (): TestD1Database => {
  const database = new TestD1Database();
  databases.push(database);
  return database;
};
const link = (discordUserId: string, twitchUserId: string, discordUsername: string, twitchLogin: string): DiscordLink => ({
  discordUserId,
  twitchUserId,
  discordUsername,
  twitchLogin,
  linkedAt: "2026-11-24T10:00:00.000Z",
  verifiedAt: "2026-11-24T10:00:00.000Z",
});

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("Discord link replacement", () => {
  it("replaces an old Twitch account when the same Discord account relinks", async () => {
    const database = createDatabase();
    await replaceDiscordLink(database as unknown as D1Database, link("discord-one", "twitch-one", "nightowl", "nightowl_dev"));

    const replacement = await replaceDiscordLink(database as unknown as D1Database,
      link("discord-one", "twitch-two", "nightowl", "nightowl_alt"));

    expect(replacement.replacedRows).toEqual([link("discord-one", "twitch-one", "nightowl", "nightowl_dev")]);
    await expect(getDiscordLink(database as unknown as D1Database, "discord-one")).resolves.toEqual(
      link("discord-one", "twitch-two", "nightowl", "nightowl_alt"));
  });

  it("replaces an old Discord account when another account claims its Twitch identity", async () => {
    const database = createDatabase();
    await replaceDiscordLink(database as unknown as D1Database, link("discord-one", "twitch-one", "nightowl", "nightowl_dev"));

    const replacement = await replaceDiscordLink(database as unknown as D1Database,
      link("discord-two", "twitch-one", "nightowl_alt", "nightowl_dev"));

    expect(replacement.replacedRows).toEqual([link("discord-one", "twitch-one", "nightowl", "nightowl_dev")]);
    await expect(getDiscordLink(database as unknown as D1Database, "discord-one")).resolves.toBeNull();
    await expect(getDiscordLink(database as unknown as D1Database, "discord-two")).resolves.toEqual(
      link("discord-two", "twitch-one", "nightowl_alt", "nightowl_dev"));
  });

  it("returns the removed row for later role cleanup", async () => {
    const database = createDatabase();
    const current = link("discord-one", "twitch-one", "nightowl", "nightowl_dev");
    await replaceDiscordLink(database as unknown as D1Database, current);

    await expect(removeDiscordLink(database as unknown as D1Database, "discord-one")).resolves.toEqual(current);
    await expect(getDiscordLink(database as unknown as D1Database, "discord-one")).resolves.toBeNull();
  });
});
