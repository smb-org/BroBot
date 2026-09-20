import { describe, expect, it, vi } from "vitest";

import {
  BOT_SCOPES,
  LOGIN_SCOPES,
  exchangeAuthorizationCode,
  fetchTwitchUser,
  missingBotScopes,
  startOAuthAuthorization,
  verifyOAuthState,
} from "../../src/worker/auth/oauth";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const environment = {
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  PUBLIC_ORIGIN: "https://brobot.example",
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const fakeDatabase = () => {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  return {
    database: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
    statement,
  };
};

describe("Twitch-OAuth", () => {
  it("ermittelt fehlende Bot-Scopes unabhängig von Reihenfolge und Zusatz-Scopes", () => {
    expect(missingBotScopes(["user:write:chat", "user:bot", "extra:scope"])).toEqual(
      BOT_SCOPES.filter((scope) => scope !== "user:bot" && scope !== "user:write:chat"),
    );
    expect(missingBotScopes([...BOT_SCOPES].reverse())).toEqual([]);
    expect(missingBotScopes([...BOT_SCOPES, "extra:scope"])).toEqual([]);
  });

  it("erzeugt für Login und Bot unterschiedliche, vollständige Scope-URLs", async () => {
    const { database } = fakeDatabase();
    const login = await startOAuthAuthorization(database, environment, "login", "2026-09-18T00:00:00.000Z");
    const bot = await startOAuthAuthorization(database, environment, "bot", "2026-09-18T00:00:00.000Z");
    const loginUrl = new URL(login.url);
    const botUrl = new URL(bot.url);

    expect(loginUrl.pathname).toBe("/oauth2/authorize");
    expect(loginUrl.searchParams.get("redirect_uri")).toBe("https://brobot.example/auth/twitch/callback");
    expect(loginUrl.searchParams.get("scope")?.split(" ")).toEqual([...LOGIN_SCOPES]);
    expect(botUrl.searchParams.get("scope")?.split(" ")).toEqual([...BOT_SCOPES]);
    expect(botUrl.searchParams.get("scope")?.split(" ")).toContain("user:read:moderated_channels");
    expect(botUrl.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining([
      "moderator:manage:blocked_terms",
      "moderator:manage:chat_settings",
      "moderator:manage:unban_requests",
      "moderator:manage:banned_users",
      "moderator:manage:warnings",
      "moderator:read:moderators",
      "moderator:read:vips",
    ]));
    expect(loginUrl.searchParams.get("state")).not.toBe(botUrl.searchParams.get("state"));
  });

  it("akzeptiert keinen manipulierten State", async () => {
    const { database } = fakeDatabase();
    const started = await startOAuthAuthorization(database, environment, "login", "2026-09-18T00:00:00.000Z");
    const parsed = await verifyOAuthState(`${started.state}x`, environment.SESSION_COOKIE_KEYS, "2026-09-18T00:00:00.000Z", started.stateNonce);

    expect(parsed).toBeNull();
  });

  it("liest einen signierten State ohne zusätzliche Verifier-Daten", async () => {
    const { database } = fakeDatabase();
    const started = await startOAuthAuthorization(database, environment, "bot", "2026-09-18T00:00:00.000Z");
    const state = await verifyOAuthState(started.state, environment.SESSION_COOKIE_KEYS, "2026-09-18T00:00:00.000Z", started.stateNonce);

    expect(state?.purpose).toBe("bot");
    expect(state?.transactionId).toBe(started.transactionId);
  });

  it("behandelt einen abgelehnten Code-Tausch als OAuth-Fehler", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "access_denied", message: "Zugriff abgelehnt" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ));

    await expect(exchangeAuthorizationCode(
      fetcher,
      environment,
      "code",
    )).rejects.toThrow("Twitch-Code-Tausch wurde abgelehnt.");
  });

  it("liest die Twitch-Identität ohne E-Mail-Scope", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: "user-1", login: "tester", display_name: "Tester" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await expect(fetchTwitchUser(fetcher, environment, "access-token")).resolves.toEqual({
      userId: "user-1",
      login: "tester",
    });
    expect(fetcher).toHaveBeenCalledWith("https://api.twitch.tv/helix/users", {
      headers: {
        "Client-ID": "client-id",
        Authorization: "Bearer access-token",
      },
    });
  });

  it("verifiziert ablaufende States nicht", async () => {
    const { database } = fakeDatabase();
    const started = await startOAuthAuthorization(database, environment, "login", "2026-09-18T00:00:00.000Z");
    const state = await verifyOAuthState(started.state, environment.SESSION_COOKIE_KEYS, "2026-09-18T00:11:00.000Z", started.stateNonce);

    expect(state).toBeNull();
  });
});
