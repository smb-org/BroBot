import { describe, expect, it, vi } from "vitest";

import {
  DiscordRequestError,
  discordApiRequest,
  getDiscordGuildMember,
} from "../../src/modules/discord/adapters/discord";

const environment = {
  APP_ENV: "local" as const,
  DISCORD_API_BASE: "http://discord.example/api/v10",
  DISCORD_BOT_TOKEN: "fictional-discord-bot-token",
};

describe("Discord role API adapter", () => {
  it("uses the bot token and an audit reason for a role grant", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));

    await discordApiRequest(environment, "PUT", "/guilds/990000000000000101/members/990000000000000201/roles/990000000000000102", undefined, "BroBot: Twitch VIP", fetcher);

    const init = fetcher.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("PUT");
    expect(headers.get("Authorization")).toBe("Bot fictional-discord-bot-token");
    expect(headers.get("X-Audit-Log-Reason")).toBe("BroBot%3A%20Twitch%20VIP");
  });

  it("parses a Discord member with joined_at from the documented payload", async () => {
    const member = await getDiscordGuildMember(environment, "990000000000000101", "990000000000000201", vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({
        user: { id: "990000000000000201" },
        roles: ["990000000000000102"],
        joined_at: "2026-11-01T10:00:00.000Z",
      })),
    ));

    expect(member).toEqual({
      userId: "990000000000000201",
      roles: ["990000000000000102"],
      joinedAt: "2026-11-01T10:00:00.000Z",
    });
  });

  it("retains the response code and retry_after seconds for a rate limit", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(
      { code: 20028, message: "rate limited", retry_after: 2.75, global: false },
      { status: 429 },
    )));

    await expect(discordApiRequest(environment, "GET", "/guilds/990000000000000101", undefined, undefined, fetcher))
      .rejects.toMatchObject({ status: 429, discordCode: 20028, retryAfterSeconds: 2.75 });
    expect(DiscordRequestError).toBeDefined();
  });
});
