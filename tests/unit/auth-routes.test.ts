import { beforeEach, describe, expect, it, vi } from "vitest";

import { authRouter, getSessionFromRequest } from "../../src/worker/auth/routes";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { LOGIN_SCOPES } from "../../src/worker/auth/oauth";
import { maintainBotIdentity } from "../../src/worker/bot-maintenance";
import { maintainEventSubSubscriptions } from "../../src/worker/eventsub-subscriptions";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";
import { listeAlleBroadcasterScopes } from "../../src/worker/module-scopes";

vi.mock("../../src/worker/bot-maintenance", () => ({
  maintainBotIdentity: vi.fn(),
}));

vi.mock("../../src/worker/eventsub-subscriptions", () => ({
  maintainEventSubSubscriptions: vi.fn(),
}));

const mockedMaintainBotIdentity = vi.mocked(maintainBotIdentity);
const mockedMaintainEventSubSubscriptions = vi.mocked(maintainEventSubSubscriptions);

/**
 * Ein CSRF-Token fuer den Jetzt-Zeitpunkt. Ein festes Datum waere eine
 * Zeitbombe: Die geprueften Routen verwenden die echte Uhr, also liefe das
 * Token sieben Tage spaeter ab und der Test wuerde rot, ohne dass jemand
 * etwas geaendert haette. Den Ablauf selbst prueft csrf.test.ts mit
 * ausdruecklich uebergebenen Zeitpunkten.
 */
const frischerZeitpunkt = (): string => new Date().toISOString();

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const sessionRowFor = (userId: string) => ({
  session_id: `session-${userId}`,
  user_id: userId,
  login: userId,
  expires_at: "2099-09-19T00:00:00.000Z",
  created_at: "2026-09-18T00:00:00.000Z",
  updated_at: "2026-09-18T00:00:00.000Z",
  revoked_at: null,
  revocation_reason: null,
});

/**
 * `sessionRow` beantwortet gezielt die Session-Abfrage, `botIdentityRow` die
 * Abfrage der Bot-Identitaet; alle uebrigen Abfragen liefern `firstResult`.
 * Ohne diese Trennung kaeme dieselbe Zeile als Session UND als Bot-Identitaet
 * zurueck, was Pruefungen auf einem Mock-Artefakt statt auf Verhalten testet.
 * Nicht gesetzte Zeilen fallen auf `firstResult` zurueck, damit bestehende
 * Tests unveraendert weiterlaufen.
 */
const makeEnvironment = (
  firstResult: unknown = null,
  sessionRow?: unknown,
  botIdentityRow: unknown = null,
) => {
  let lastSql = "";
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockImplementation(() => {
      if (lastSql.includes("FROM auth_sessions")) {
        return Promise.resolve(sessionRow === undefined ? firstResult : sessionRow);
      }
      if (lastSql.includes("FROM bot_identity")) return Promise.resolve(botIdentityRow);
      return Promise.resolve(firstResult);
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  const environment = {
    DB: {
      prepare: vi.fn().mockImplementation((sql: string) => {
        lastSql = sql;
        return statement;
      }),
      batch: vi.fn(async (statements: D1PreparedStatement[]) => Promise.all(
        statements.map((batchStatement) => batchStatement.run()),
      )),
    } as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TWITCH_BOT_LOGIN: "brobot",
    TWITCH_EVENTSUB_SECRET: JSON.stringify({ active: { id: "eventsub-v1", key: key(3) }, retired: [] }),
    PUBLIC_ORIGIN: "https://brobot.example",
    SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
    SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
    OVERLAY_TOKEN_PEPPER: key(4),
  } as unknown as Env & { SESSION_ENCRYPTION_KEYS: string };
  return { environment, statement };
};

/** Liest den Nonce aus dem State-Cookie, das der Login-Start gesetzt hat. */
const stateNonceFrom = (response: Response): string => {
  const cookie = response.headers.get("set-cookie") ?? "";
  return /__Host-brobot_oauth_state=([^;]*)/.exec(cookie)?.[1] ?? "";
};

/** Baut den Callback samt State-Cookie, also so, wie der startende Browser ihn schickt. */
const callbackRequest = (login: Response, query = "&code=code"): Request => {
  const loginUrl = new URL(login.headers.get("location") ?? "https://invalid");
  const state = encodeURIComponent(loginUrl.searchParams.get("state") ?? "");
  return new Request(`https://brobot.example/auth/twitch/callback?state=${state}${query}`, {
    headers: { Cookie: `__Host-brobot_oauth_state=${stateNonceFrom(login)}` },
  });
};

const sessionCookieHeaderFor = async (userId: string): Promise<string> => {
  const cookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
    JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
  );
  return `__Host-brobot_session=${cookie}`;
};

const csrfTokenFrom = async (response: Response): Promise<string> => {
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || !("token" in body) ||
      typeof body.token !== "string") {
    throw new Error("Antwort enthält kein CSRF-Token.");
  }
  return body.token;
};

const fetchWith = (...responses: Response[]) => {
  const fetcher = vi.fn();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

const umgebungFürDatenbank = (datenbank: TestD1Database) => {
  const { environment } = makeEnvironment();
  environment.DB = datenbank as unknown as D1Database;
  return environment;
};

const setzeVollzustimmung = async (datenbank: TestD1Database, kanalId: string): Promise<void> => {
  await datenbank.prepare(
    "UPDATE channels SET full_consent = 1 WHERE channel_id = ?",
  ).bind(kanalId).run();
};

const tokenAntwort = (scopes: readonly string[]): Response => new Response(
  JSON.stringify({
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 3600,
    scope: scopes,
  }),
  { status: 200 },
);

const identitätsAntwort = (userId: string, login: string): Response => new Response(
  JSON.stringify({ data: [{ id: userId, login }] }),
  { status: 200 },
);

const anzahlZeilen = async (datenbank: TestD1Database, tabelle: string): Promise<number> => {
  const zeile = await datenbank.prepare(`SELECT COUNT(*) AS count FROM ${tabelle}`).first<{ count: number }>();
  return zeile?.count ?? 0;
};

describe("Auth-Routen", () => {
  beforeEach(() => {
    mockedMaintainBotIdentity.mockReset();
    mockedMaintainEventSubSubscriptions.mockReset();
  });

  it("startet Login mit einem Twitch-Redirect und bindet den State an den Browser", async () => {
    const { environment } = makeEnvironment();
    const response = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://id.twitch.tv/oauth2/authorize");
    // Kein Session-Cookie — der Login ist noch nicht abgeschlossen.
    expect(cookie).not.toContain("__Host-brobot_session=");
    expect(cookie).toContain("__Host-brobot_oauth_state=");
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(stateNonceFrom(response).length).toBeGreaterThan(0);
  });

  it("gibt einem markierten Kanal beim Einladungslink den vollständigen Umfang", async () => {
    const datenbank = new TestD1Database();
    try {
      await insertChannel(datenbank, "kanal-voll");
      await setzeVollzustimmung(datenbank, "kanal-voll");
      const umgebung = umgebungFürDatenbank(datenbank);

      const antwort = await authRouter.fetch(
        new Request("https://brobot.example/auth/login?channel=KANAL-VOLL"),
        umgebung,
      );
      const umfang = new URL(antwort.headers.get("location") ?? "https://ungültig").searchParams
        .get("scope")?.split(" ");

      expect(antwort.status).toBe(302);
      expect(umfang).toEqual(listeAlleBroadcasterScopes());
    } finally {
      datenbank.close();
    }
  });

  it("gibt einem unmarkierten Kanal beim Einladungslink nur den bisherigen Login-Umfang", async () => {
    const datenbank = new TestD1Database();
    try {
      await insertChannel(datenbank, "kanal-normal");
      const umgebung = umgebungFürDatenbank(datenbank);

      const antwort = await authRouter.fetch(
        new Request("https://brobot.example/auth/login?channel=kanal-normal"),
        umgebung,
      );
      const umfang = new URL(antwort.headers.get("location") ?? "https://ungültig").searchParams
        .get("scope")?.split(" ");

      expect(antwort.status).toBe(302);
      expect(umfang).toEqual([...LOGIN_SCOPES]);
    } finally {
      datenbank.close();
    }
  });

  it("ignoriert einen unbekannten Einladungslink-Kanal vollständig", async () => {
    const datenbank = new TestD1Database();
    try {
      await insertChannel(datenbank, "kanal-voll");
      await setzeVollzustimmung(datenbank, "kanal-voll");
      const umgebung = umgebungFürDatenbank(datenbank);
      const erfundenerLogin = "kanal-voll-aber-erfunden";

      const antwort = await authRouter.fetch(
        new Request(`https://brobot.example/auth/login?channel=${erfundenerLogin}`),
        umgebung,
      );
      const url = new URL(antwort.headers.get("location") ?? "https://ungültig");

      expect(antwort.status).toBe(302);
      expect(url.searchParams.get("scope")?.split(" ")).toEqual([...LOGIN_SCOPES]);
      expect(url.toString()).not.toContain(erfundenerLogin);
    } finally {
      datenbank.close();
    }
  });

  it("speichert bei unvollständigem Token weder Identität noch Sitzung und startet den zweiten Versuch", async () => {
    const datenbank = new TestD1Database();
    try {
      await insertChannel(datenbank, "kanal-voll");
      await setzeVollzustimmung(datenbank, "kanal-voll");
      const umgebung = umgebungFürDatenbank(datenbank);
      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/login"),
        umgebung,
      );
      const fetcher = fetchWith(
        tokenAntwort(LOGIN_SCOPES),
        identitätsAntwort("kanal-voll", "kanal-voll"),
      );

      const antwort = await authRouter.fetch(callbackRequest(login), umgebung);
      const zweiteUrl = new URL(antwort.headers.get("location") ?? "https://ungültig");

      expect(antwort.status).toBe(302);
      expect(zweiteUrl.searchParams.get("scope")?.split(" ")).toEqual(listeAlleBroadcasterScopes());
      expect(await anzahlZeilen(datenbank, "twitch_login_identity")).toBe(0);
      expect(await anzahlZeilen(datenbank, "auth_sessions")).toBe(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      datenbank.close();
    }
  });

  it("beendet den zweiten unvollständigen Rücklauf mit 403 statt in einer Schleife", async () => {
    const datenbank = new TestD1Database();
    try {
      await insertChannel(datenbank, "kanal-voll");
      await setzeVollzustimmung(datenbank, "kanal-voll");
      const umgebung = umgebungFürDatenbank(datenbank);
      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/login"),
        umgebung,
      );
      const fetcher = fetchWith(
        tokenAntwort(LOGIN_SCOPES),
        identitätsAntwort("kanal-voll", "kanal-voll"),
        tokenAntwort(LOGIN_SCOPES),
        identitätsAntwort("kanal-voll", "kanal-voll"),
      );

      const ersteAntwort = await authRouter.fetch(callbackRequest(login), umgebung);
      const zweiteAntwort = await authRouter.fetch(callbackRequest(ersteAntwort), umgebung);

      expect(zweiteAntwort.status).toBe(403);
      await expect(zweiteAntwort.text()).resolves.toContain("vollständige Zustimmung");
      expect(await anzahlZeilen(datenbank, "twitch_login_identity")).toBe(0);
      expect(await anzahlZeilen(datenbank, "auth_sessions")).toBe(0);
      await expect(datenbank.prepare(
        "SELECT failure_reason FROM oauth_transactions WHERE failure_reason = ?",
      ).bind("vollzustimmung_zweiter_versuch_unvollständig").all()).resolves.toMatchObject({
        results: [{ failure_reason: "vollzustimmung_zweiter_versuch_unvollständig" }],
      });
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      datenbank.close();
    }
  });

  it("legt ein vollständiges Token ohne zweite Umleitung an", async () => {
    const datenbank = new TestD1Database();
    try {
      await insertChannel(datenbank, "kanal-voll");
      await setzeVollzustimmung(datenbank, "kanal-voll");
      const umgebung = umgebungFürDatenbank(datenbank);
      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/login?channel=kanal-voll"),
        umgebung,
      );
      const fetcher = fetchWith(
        tokenAntwort(listeAlleBroadcasterScopes()),
        identitätsAntwort("kanal-voll", "kanal-voll"),
      );

      const antwort = await authRouter.fetch(callbackRequest(login), umgebung);

      expect(antwort.status).toBe(302);
      expect(antwort.headers.get("location")).toBe("https://brobot.example/");
      expect(await anzahlZeilen(datenbank, "twitch_login_identity")).toBe(1);
      expect(await anzahlZeilen(datenbank, "auth_sessions")).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      datenbank.close();
    }
  });

  it("weist einen falschen State zurück", async () => {
    const { environment } = makeEnvironment();
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/twitch/callback?state=manipuliert&code=code"),
      environment,
    );

    expect(response.status).toBe(400);
  });

  it("legt nach erfolgreichem Login eine serverseitige Session ohne Token im Cookie an", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const fetcher = fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:read:moderated_channels"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "user-1", login: "tester" }] }), { status: 200 }),
    );
    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
    );
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(cookie).toContain("__Host-brobot_session=");
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(cookie).not.toContain("access");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("user-1") && args.includes("tester"))).toBe(true);
    expect(statement.bind.mock.calls.some((args: unknown[]) =>
      args[0] === "user-1" && args[2] === JSON.stringify(["user:read:moderated_channels"]))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("führt einen serverseitig hinterlegten Modul-Rückweg aus", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      redirect_path: "/channels/kanal-a/modules/ads",
    };
    const { environment } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "user-1", login: "tester" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(callbackRequest(login), environment);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://brobot.example/channels/kanal-a/modules/ads");
  });

  it("ignoriert ein nicht einfaches hinterlegtes Rückwegziel", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      redirect_path: "https://angreifer.example/weiter",
    };
    const { environment } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "user-1", login: "tester" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(callbackRequest(login), environment);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://brobot.example/");
  });

  it("legt bei der Betreiberautorisierung nur die globale Bot-Identität an", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction, sessionRowFor("betreiber"));
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("betreiber") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "foreign-user", login: "someone-else" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
    );

    expect(response.status).toBe(403);
    // Das verbrauchte State-Cookie wird geräumt; eine Session entsteht nicht.
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__Host-brobot_session=");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("foreign-user") || args.includes("someone-else"))).toBe(false);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args[0] === "bot_identity_mismatch")).toBe(true);
    expect(mockedMaintainBotIdentity).not.toHaveBeenCalled();
    expect(mockedMaintainEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it("akzeptiert den konfigurierten Bot-Login case-insensitiv", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction, sessionRowFor("betreiber"));
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("betreiber") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "bot-user", login: "BROBOT" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
    );

    expect(response.status).toBe(302);
    // Die Betreiberautorisierung legt keine Anmeldesession an.
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__Host-brobot_session=");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("bot-user") && args.includes("BROBOT"))).toBe(true);
  });

  it("stößt nach erfolgreicher Bot-Autorisierung beide globalen Wartungsläufe sequenziell an", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction, sessionRowFor("betreiber"));
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("betreiber") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "bot-user", login: "brobot" }] }), { status: 200 }),
    );
    const order: string[] = [];
    mockedMaintainBotIdentity.mockImplementation(() => {
      order.push("identity");
      return Promise.resolve();
    });
    mockedMaintainEventSubSubscriptions.mockImplementation(() => {
      order.push("eventsub");
      return Promise.resolve();
    });
    const waitUntil = vi.fn();

    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
      { waitUntil } as unknown as ExecutionContext,
    );
    const maintenance = waitUntil.mock.calls[0]?.[0] as Promise<void> | undefined;
    expect(response.status).toBe(302);
    expect(maintenance).toBeDefined();
    await maintenance;

    expect(order).toEqual(["identity", "eventsub"]);
    expect(mockedMaintainBotIdentity).toHaveBeenCalledWith(environment, expect.any(String));
    expect(mockedMaintainEventSubSubscriptions).toHaveBeenCalledWith(environment, expect.any(String));
    expect(mockedMaintainEventSubSubscriptions.mock.calls[0]).toHaveLength(2);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("bot-user") && args.includes("brobot"))).toBe(true);
  });

  it("wartet bei der Weiterleitung nicht auf die Wartung", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment } = makeEnvironment(transaction, sessionRowFor("betreiber"));
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("betreiber") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "bot-user", login: "brobot" }] }), { status: 200 }),
    );
    let releaseIdentity: (() => void) | undefined;
    const identityPending = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    mockedMaintainBotIdentity.mockReturnValue(identityPending);
    const waitUntil = vi.fn();

    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(302);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(mockedMaintainBotIdentity).toHaveBeenCalledTimes(1);
    expect(mockedMaintainEventSubSubscriptions).not.toHaveBeenCalled();

    releaseIdentity?.();
    const maintenance = waitUntil.mock.calls[0]?.[0] as Promise<void> | undefined;
    await maintenance;
    expect(mockedMaintainEventSubSubscriptions).toHaveBeenCalledTimes(1);
  });

  it.each(["Bot-Identität", "EventSub-Abos"])(
    "lässt die Weiterleitung und die gespeicherte Identität bei einem Fehler im Lauf %s gültig",
    async (failedRun) => {
      const transaction = {
        transaction_id: "transaction-1",
        purpose: "bot",
        expires_at: "2099-09-18T00:05:00.000Z",
        created_at: "2099-09-18T00:00:00.000Z",
      };
      const { environment, statement } = makeEnvironment(transaction, sessionRowFor("betreiber"));
      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/bot/login", {
          headers: { Cookie: await sessionCookieHeaderFor("betreiber") },
        }),
        environment,
      );
      fetchWith(
        new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
        new Response(JSON.stringify({ data: [{ id: "bot-user", login: "brobot" }] }), { status: 200 }),
      );
      if (failedRun === "Bot-Identität") {
        mockedMaintainBotIdentity.mockRejectedValueOnce(new Error("identity failed"));
      } else {
        mockedMaintainEventSubSubscriptions.mockRejectedValueOnce(new Error("eventsub failed"));
      }
      const waitUntil = vi.fn();

      const response = await authRouter.fetch(
        callbackRequest(login),
        environment,
        { waitUntil } as unknown as ExecutionContext,
      );
      const maintenance = waitUntil.mock.calls[0]?.[0] as Promise<void> | undefined;
      await maintenance;

      expect(response.status).toBe(302);
      expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("bot-user") && args.includes("brobot"))).toBe(true);
      expect(mockedMaintainBotIdentity).toHaveBeenCalledTimes(1);
      expect(mockedMaintainEventSubSubscriptions).toHaveBeenCalledTimes(1);
    },
  );

  it("stößt beim Login-Rückweg keine Bot-Wartung an", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "user-1", login: "tester" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(callbackRequest(login), environment);

    expect(response.status).toBe(302);
    expect(mockedMaintainBotIdentity).not.toHaveBeenCalled();
    expect(mockedMaintainEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it("stellt einer gültigen Session ein gebundenes CSRF-Token aus", async () => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );

    const response = await authRouter.fetch(
      new Request("https://brobot.example/api/csrf", {
        headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
      }),
      environment,
    );

    const body = await response.json<{ token: string }>();
    expect(response.status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("__Host-brobot_csrf=");
    expect(response.headers.get("set-cookie")).not.toContain("HttpOnly");
  });

  it("weist einen schreibenden Logout ohne CSRF-Token zurück", async () => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );

    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/logout", {
        method: "POST",
        headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
      }),
      environment,
    );

    expect(response.status).toBe(403);
  });

  it("beendet eine Session serverseitig und löscht das Cookie mit CSRF-Token", async () => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );
    const csrfToken = await createCsrfToken(
      "session-1",
      environment.SESSION_COOKIE_KEYS,
      frischerZeitpunkt(),
    );

    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/logout", {
        method: "POST",
        headers: {
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
          "X-CSRF-Token": csrfToken,
        },
      }),
      environment,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    ["nicht parsebarer", "kein-datum"],
    ["tatsächlich abgelaufener", "2000-01-01T00:00:00.000Z"],
  ])("verwirft eine %s Session-Ablaufzeit aus der Datenbank", async (_description, expiresAt) => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: expiresAt,
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );

    await expect(getSessionFromRequest(
      new Request("https://brobot.example/", {
        headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
      }),
      environment,
    )).resolves.toBeNull();
  });

  it("akzeptiert den CSRF-Token nach dem Logout nicht erneut", async () => {
    const { environment, statement } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    let revoked = false;
    statement.run.mockImplementation(() => {
      revoked = true;
      return { success: true, meta: { changes: 1 } };
    });
    statement.first.mockImplementation(() => revoked ? {
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: "2026-09-18T00:00:00.000Z",
      revocation_reason: "logout",
    } : {
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );
    const csrfToken = await createCsrfToken(
      "session-1",
      environment.SESSION_COOKIE_KEYS,
      frischerZeitpunkt(),
    );
    const request = new Request("https://brobot.example/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
        "X-CSRF-Token": csrfToken,
      },
    });

    await expect(authRouter.fetch(request, environment)).resolves.toHaveProperty("status", 204);
    await expect(authRouter.fetch(request, environment)).resolves.toHaveProperty("status", 401);
  });

  it("liefert die Identität aus der D1-Session und nicht aus dem Cookie", async () => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "db-user",
      login: "db-login",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const cookie = await createSessionCookie(
      {
        sessionId: "session-1",
        userId: "cookie-user",
        login: "cookie-login",
        expiresAt: "2099-09-19T00:00:00.000Z",
      } as { sessionId: string },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );

    await expect(getSessionFromRequest(
      new Request("https://brobot.example/", { headers: { Cookie: `__Host-brobot_session=${cookie}` } }),
      environment,
    )).resolves.toMatchObject({ userId: "db-user", login: "db-login" });
  });

  it("akzeptiert keine Session mit widerrufener Login-Identität über den echten SQLite-Join", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO twitch_login_identity
          (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, status, reason, created_at, updated_at)
         VALUES (?, ?, '[]', 'access', 'refresh', ?, 'revoked', ?, ?, ?)`,
      ).bind(
        "user-1",
        "tester",
        "2099-09-19T00:00:00.000Z",
        "authorization_revoked",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      await database.prepare(
        `INSERT INTO auth_sessions
          (session_id, user_id, login, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        "session-1",
        "user-1",
        "tester",
        "2099-09-19T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      const { environment } = makeEnvironment();
      environment.DB = database as unknown as D1Database;
      const cookie = await createSessionCookie(
        { sessionId: "session-1" },
        environment.SESSION_COOKIE_KEYS,
        environment.SESSION_ENCRYPTION_KEYS,
      );

      await expect(getSessionFromRequest(
        new Request("https://brobot.example/", {
          headers: { Cookie: `__Host-brobot_session=${cookie}` },
        }),
        environment,
      )).resolves.toBeNull();
    } finally {
      database.close();
    }
  });

  it("meldet einen abgelehnten Code-Tausch ohne Tokeninhalte", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    fetchWith(new Response(JSON.stringify({ error: "access_denied" }), { status: 400 }));
    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("access");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("code_exchange_rejected"))).toBe(true);
  });

  it("meldet niemanden an, wenn der Callback ohne State-Cookie aufgerufen wird", async () => {
    // Nachgestellt: Der Angreifer startet den Login für sein Konto, fängt die
    // unverbrauchte Callback-URL ab und lässt das Opfer sie öffnen. Ohne
    // Browser-Bindung wäre das Opfer danach als Angreifer angemeldet.
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const loginUrl = new URL(login.headers.get("location") ?? "https://invalid");
    const fetcher = fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "angreifer", login: "angreifer" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      new Request(
        `https://brobot.example/auth/twitch/callback?state=${encodeURIComponent(loginUrl.searchParams.get("state") ?? "")}&code=code`,
      ),
      environment,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__Host-brobot_session=");
    // Der Code wird gar nicht erst eingelöst.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("meldet niemanden an, wenn das State-Cookie aus einem anderen Login stammt", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment } = makeEnvironment(transaction);
    const angreiferLogin = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const opferLogin = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const angreiferUrl = new URL(angreiferLogin.headers.get("location") ?? "https://invalid");
    const fetcher = fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "angreifer", login: "angreifer" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      new Request(
        `https://brobot.example/auth/twitch/callback?state=${encodeURIComponent(angreiferUrl.searchParams.get("state") ?? "")}&code=code`,
        { headers: { Cookie: `__Host-brobot_oauth_state=${stateNonceFrom(opferLogin)}` } },
      ),
      environment,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__Host-brobot_session=");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("verlangt für den Start der Bot-Verbindung eine Session", async () => {
    // Sonst bestimmt jeder Unangemeldete, welches Twitch-Konto der Bot benutzt.
    const { environment } = makeEnvironment();
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login"),
      environment,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });

  it("lässt einen Verwalter die channel:bot-Zustimmung nicht für den Broadcaster starten", async () => {
    const { environment } = makeEnvironment(
      { role: "manager" },
      sessionRowFor("verwalter"),
    );
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/channels/kanal-a/channel-bot", {
        headers: { Cookie: await sessionCookieHeaderFor("verwalter") },
      }),
      environment,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });

  it("startet die channel:bot-Nachforderung für den Broadcaster des Kanals", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a");
      await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
      const { environment } = makeEnvironment();
      environment.DB = database as unknown as D1Database;

      const response = await authRouter.fetch(
        new Request("https://brobot.example/auth/channels/kanal-a/channel-bot", {
          headers: { Cookie: await sessionCookieHeaderFor("kanal-a") },
        }),
        environment,
      );

      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") ?? "https://invalid").searchParams.get("scope"))
        .toContain("channel:bot");
    } finally {
      database.close();
    }
  });

  it("verwirft den Callback mit einer anderen Kanalinhaber-Identität ohne Speicherung", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a");
      await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
      const environment = umgebungFürDatenbank(database);

      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/channels/kanal-a/broadcaster-scopes/ads", {
          headers: { Cookie: await sessionCookieHeaderFor("kanal-a") },
        }),
        environment,
      );
      expect(login.status).toBe(302);
      await expect(database.prepare(
        "SELECT expected_user_id FROM oauth_transactions",
      ).first()).resolves.toEqual({ expected_user_id: "kanal-a" });

      fetchWith(tokenAntwort(LOGIN_SCOPES), identitätsAntwort("fremdes-konto", "fremdes-konto"));
      const response = await authRouter.fetch(callbackRequest(login), environment);

      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toContain("Kanalinhaber");
      await expect(database.prepare(
        "SELECT user_id FROM twitch_login_identity ORDER BY user_id",
      ).all()).resolves.toMatchObject({ results: [{ user_id: "kanal-a" }] });
      await expect(database.prepare(
        "SELECT failure_reason FROM oauth_transactions WHERE transaction_id = (SELECT transaction_id FROM oauth_transactions LIMIT 1)",
      ).first()).resolves.toEqual({ failure_reason: "login_identity_user_mismatch" });
    } finally {
      database.close();
    }
  });

  it("übernimmt keine Bot-Identität mit abweichender Twitch-User-ID", async () => {
    // Logins lassen sich ändern und neu vergeben. Wird der Bot-Account
    // umbenannt und jemand registriert den frei gewordenen Namen, darf er die
    // Bot-Identität nicht übernehmen — sonst postet der Bot in allen Kanälen
    // aus einem fremden Konto.
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(
      transaction,
      sessionRowFor("betreiber"),
      {
        id: 1,
        user_id: "echter-bot",
        login: "brobot",
        scopes_json: "[]",
        access_token_ciphertext: "access",
        refresh_token_ciphertext: "refresh",
        expires_at: "2099-09-19T00:00:00.000Z",
        created_at: "2026-09-18T00:00:00.000Z",
        updated_at: "2026-09-18T00:00:00.000Z",
      },
    );
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("betreiber") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      // Gleicher Login, andere User-ID: der Name wurde neu vergeben.
      new Response(JSON.stringify({ data: [{ id: "uebernehmer", login: "brobot" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(callbackRequest(login), environment);

    expect(response.status).toBe(403);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("uebernehmer"))).toBe(false);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args[0] === "bot_identity_user_mismatch")).toBe(true);
    expect(mockedMaintainBotIdentity).not.toHaveBeenCalled();
    expect(mockedMaintainEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it("gibt zwei Abrufen dasselbe CSRF-Token, damit ein zweiter Tab den ersten nicht entwertet", async () => {
    // Überschreibt jeder Abruf das gemeinsame Cookie, scheitert der Logout des
    // ersten Tabs mit 403 — der Worker widerruft dann nichts.
    const { environment } = makeEnvironment(sessionRowFor("user-1"));
    const cookieHeader = await sessionCookieHeaderFor("user-1");

    const erster = await authRouter.fetch(
      new Request("https://brobot.example/api/csrf", { headers: { Cookie: cookieHeader } }),
      environment,
    );
    const ersterToken = await csrfTokenFrom(erster);

    const zweiter = await authRouter.fetch(
      new Request("https://brobot.example/api/csrf", {
        headers: { Cookie: `${cookieHeader}; __Host-brobot_csrf=${ersterToken}` },
      }),
      environment,
    );
    const zweiterToken = await csrfTokenFrom(zweiter);

    expect(zweiterToken).toBe(ersterToken);
    // Kein neues Cookie, also bleibt das Token des ersten Tabs gültig.
    expect(zweiter.headers.get("set-cookie")).toBeNull();
  });
});
