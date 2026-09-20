import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createSessionCookie } from "../../src/worker/auth/session";
import {
  ändereBetreiberMitglied,
  entferneBetreiberMitglied,
  fügeBetreiberMitgliedHinzu,
} from "../../src/worker/betreiber/repository";
import { betreiberRouter } from "../../src/worker/betreiber/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const schlüssel = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const umgebungsSchlüssel = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: schlüssel(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: schlüssel(2) }, retired: [] }),
};

const betreiberId = "26876135";

const umgebungFür = (datenbank: TestD1Database, betreiber = [betreiberId]): Env => ({
  DB: datenbank as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_BOT_LOGIN: "brobot",
  PUBLIC_ORIGIN: "https://brobot.example",
  BETREIBER_USER_IDS: JSON.stringify(betreiber),
  ...umgebungsSchlüssel,
} as unknown as Env);

const anfrageFür = async (
  userId: string,
  pfad: string,
  methode = "GET",
  rumpf?: Record<string, unknown>,
): Promise<Request> => {
  const sitzungsCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    umgebungsSchlüssel.SESSION_COOKIE_KEYS,
    umgebungsSchlüssel.SESSION_ENCRYPTION_KEYS,
  );
  const csrfToken = await createCsrfToken(
    `session-${userId}`,
    umgebungsSchlüssel.SESSION_COOKIE_KEYS,
    new Date().toISOString(),
  );
  const kopfzeilen = new Headers({
    Cookie: `__Host-brobot_session=${sitzungsCookie}; __Host-brobot_csrf=${csrfToken}`,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  const init: RequestInit = { method: methode, headers: kopfzeilen };
  if (rumpf !== undefined) init.body = JSON.stringify(rumpf);
  return new Request(`https://brobot.example${pfad}`, init);
};

const setzeBetreiber = async (datenbank: TestD1Database): Promise<void> => {
  await insertLoginIdentityAndSession(datenbank, betreiberId);
};

const setzeBotIdentität = async (datenbank: TestD1Database): Promise<void> => {
  const schlüsselring = parseKeyRing(umgebungsSchlüssel.SESSION_ENCRYPTION_KEYS);
  const zugriffstoken = await encryptJson({ token: "bot-zugriffstoken" }, schlüsselring);
  const auffrischungstoken = await encryptJson({ token: "bot-auffrischungstoken" }, schlüsselring);
  await datenbank.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, 'bot-user', 'brobot', '[]', ?, ?, ?, ?, ?)`,
  ).bind(
    zugriffstoken,
    auffrischungstoken,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const antwortVonHelix = (nutzer: Record<string, unknown>[]): Response =>
  new Response(JSON.stringify({ data: nutzer }), { status: 200 });

const leseAudit = async (datenbank: TestD1Database): Promise<Record<string, unknown>[]> =>
  (await datenbank.prepare(
    "SELECT actor_user_id, actor_kind, action, channel_id FROM audit_log ORDER BY created_at, audit_id",
  ).all<Record<string, unknown>>()).results;

describe("Betreiberebene", () => {
  let datenbank: TestD1Database;
  let umgebung: Env;

  beforeEach(() => {
    datenbank = new TestD1Database();
    umgebung = umgebungFür(datenbank);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    datenbank.close();
    vi.unstubAllGlobals();
  });

  it("weist einen Nicht-Betreiber mit 403 ab", async () => {
    await insertLoginIdentityAndSession(datenbank, "kein-betreiber");

    const antwort = await betreiberRouter.fetch(
      await anfrageFür("kein-betreiber", "/api/betreiber"),
      umgebung,
    );

    expect(antwort.status).toBe(403);
    await expect(antwort.text()).resolves.toBe("Kein Betreiberzugang.");
  });

  it("liefert die kanalübergreifende Übersicht und sucht Nutzer über Helix", async () => {
    await setzeBetreiber(datenbank);
    await insertChannel(datenbank, "kanal-a", "Alpha");
    await insertChannel(datenbank, "kanal-b", "Beta");
    await insertMember(datenbank, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(datenbank, "kanal-a", "verwalter-1", "verwalter");
    await insertMember(datenbank, "kanal-a", "bediener-1", "bediener");
    await insertMember(datenbank, "kanal-b", "kanal-b", "broadcaster");
    await datenbank.prepare("UPDATE channels SET vollzustimmung = 1 WHERE channel_id = ?").bind("kanal-a").run();
    await insertLoginIdentityAndSession(datenbank, "kanal-a");
    await setzeBotIdentität(datenbank);
    vi.mocked(fetch).mockResolvedValueOnce(antwortVonHelix([
      { id: "user-7", login: "neuerkanal", display_name: "Neuer Kanal" },
    ]));

    const übersichtAntwort = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber"),
      umgebung,
    );
    const übersicht = await übersichtAntwort.json<{
      channels: Array<Record<string, unknown>>;
    }>();
    const suchAntwort = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/nutzer?login=neuerkanal"),
      umgebung,
    );

    expect(übersichtAntwort.status).toBe(200);
    expect(übersicht.channels).toEqual([
      {
        channelId: "kanal-a",
        login: "kanal-a",
        displayName: "Alpha",
        vollzustimmung: true,
        memberCounts: { broadcaster: 1, verwalter: 1, bediener: 1 },
        broadcasterConnected: true,
      },
      {
        channelId: "kanal-b",
        login: "kanal-b",
        displayName: "Beta",
        vollzustimmung: false,
        memberCounts: { broadcaster: 1, verwalter: 0, bediener: 0 },
        broadcasterConnected: false,
      },
    ]);
    expect(suchAntwort.status).toBe(200);
    await expect(suchAntwort.json()).resolves.toEqual({
      user: { userId: "user-7", login: "neuerkanal", displayName: "Neuer Kanal", profileImageUrl: null },
    });
  });

  it("legt bei der Freigabe Kanal, Broadcaster-Zeile und Betreiber-Audit in einem Batch an", async () => {
    await setzeBetreiber(datenbank);
    await setzeBotIdentität(datenbank);
    vi.mocked(fetch).mockResolvedValueOnce(antwortVonHelix([
      { id: "kanal-7", login: "kanal-sieben", display_name: "Kanal Sieben" },
    ]));

    const antwort = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele", "POST", {
        login: "kanal-sieben",
        vollzustimmung: true,
      }),
      umgebung,
    );
    const kanal = await datenbank.prepare(
      "SELECT channel_id, login, vollzustimmung FROM channels WHERE channel_id = ?",
    ).bind("kanal-7").first();
    const mitglied = await datenbank.prepare(
      "SELECT channel_id, user_id, role FROM channel_members WHERE channel_id = ?",
    ).bind("kanal-7").first();

    expect(antwort.status).toBe(201);
    expect(kanal).toEqual({ channel_id: "kanal-7", login: "kanal-sieben", vollzustimmung: 1 });
    expect(mitglied).toEqual({ channel_id: "kanal-7", user_id: "kanal-7", role: "broadcaster" });
    await expect(leseAudit(datenbank)).resolves.toEqual([
      {
        actor_user_id: betreiberId,
        actor_kind: "betreiber",
        action: "kanal.freigegeben",
        channel_id: "kanal-7",
      },
    ]);
  });

  it("führt die drei erlaubten Mitgliedermutationen mit Betreiber-Audit aus", async () => {
    await setzeBetreiber(datenbank);
    await insertChannel(datenbank, "kanal-a");
    await insertMember(datenbank, "kanal-a", "kanal-a", "broadcaster");

    const hinzufügen = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a/mitglieder", "POST", {
        userId: "user-2",
        role: "bediener",
      }),
      umgebung,
    );
    const ändern = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a/mitglieder/user-2", "PATCH", {
        role: "verwalter",
      }),
      umgebung,
    );
    const entfernen = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a/mitglieder/user-2", "DELETE"),
      umgebung,
    );

    expect(hinzufügen.status).toBe(201);
    expect(ändern.status).toBe(200);
    expect(entfernen.status).toBe(204);
    await expect(leseAudit(datenbank)).resolves.toEqual(expect.arrayContaining([
      { actor_user_id: betreiberId, actor_kind: "betreiber", action: "mitglied.hinzugefuegt", channel_id: "kanal-a" },
      { actor_user_id: betreiberId, actor_kind: "betreiber", action: "mitglied.rolle_geaendert", channel_id: "kanal-a" },
      { actor_user_id: betreiberId, actor_kind: "betreiber", action: "mitglied.entfernt", channel_id: "kanal-a" },
    ]));
    await expect(leseAudit(datenbank)).resolves.toHaveLength(3);
  });

  it("setzt und löst die Vollzustimmung mit Audit im betroffenen Kanal", async () => {
    await setzeBetreiber(datenbank);
    await insertChannel(datenbank, "kanal-a");

    const setzen = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a", "PATCH", { vollzustimmung: true }),
      umgebung,
    );
    const lösen = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a", "PATCH", { vollzustimmung: false }),
      umgebung,
    );

    expect(setzen.status).toBe(200);
    expect(lösen.status).toBe(200);
    await expect(datenbank.prepare(
      "SELECT vollzustimmung FROM channels WHERE channel_id = ?",
    ).bind("kanal-a").first()).resolves.toEqual({ vollzustimmung: 0 });
    await expect(leseAudit(datenbank)).resolves.toEqual(expect.arrayContaining([
      { actor_user_id: betreiberId, actor_kind: "betreiber", action: "kanal.vollzustimmung_geaendert", channel_id: "kanal-a" },
    ]));
    await expect(leseAudit(datenbank)).resolves.toHaveLength(2);
  });

  it("verweigert das Setzen, Ändern und Löschen jeder Broadcaster-Zeile", async () => {
    await setzeBetreiber(datenbank);
    await insertChannel(datenbank, "kanal-a");
    await insertMember(datenbank, "kanal-a", "kanal-a", "broadcaster");

    const setzen = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a/mitglieder", "POST", {
        userId: "user-2",
        role: "broadcaster",
      }),
      umgebung,
    );
    const ändern = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a/mitglieder/kanal-a", "PATCH", {
        role: "bediener",
      }),
      umgebung,
    );
    const löschen = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a/mitglieder/kanal-a", "DELETE"),
      umgebung,
    );

    expect(setzen.status).toBe(403);
    expect(ändern.status).toBe(403);
    expect(löschen.status).toBe(403);
    await expect(datenbank.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "kanal-a").first()).resolves.toEqual({ role: "broadcaster" });
    await expect(leseAudit(datenbank)).resolves.toEqual([]);
  });

  it("sichert die Broadcaster-Sperre zusätzlich in den SQL-Mutationen", async () => {
    await setzeBetreiber(datenbank);
    await insertChannel(datenbank, "kanal-a");
    await insertMember(datenbank, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(datenbank, "kanal-a", "user-2", "bediener");
    const akteur = { userId: betreiberId, sessionId: `session-${betreiberId}` };
    const zeitpunkt = "2026-09-18T00:30:00.000Z";

    await expect(fügeBetreiberMitgliedHinzu(datenbank as unknown as D1Database, akteur, {
      channelId: "kanal-a",
      userId: "user-3",
      role: "broadcaster",
      createdAt: zeitpunkt,
      updatedAt: zeitpunkt,
    }, zeitpunkt)).resolves.toBe(false);
    const vorher = await datenbank.prepare(
      "SELECT channel_id, user_id, role, created_at, updated_at FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first<{
      channel_id: string;
      user_id: string;
      role: "broadcaster" | "verwalter" | "bediener";
      created_at: string;
      updated_at: string;
    }>();
    expect(vorher).not.toBeNull();
    if (vorher === null) throw new Error("Testmitglied fehlt.");
    const vorherMitglied = {
      channelId: vorher.channel_id,
      userId: vorher.user_id,
      role: vorher.role,
      createdAt: vorher.created_at,
      updatedAt: vorher.updated_at,
    };
    await expect(ändereBetreiberMitglied(
      datenbank as unknown as D1Database,
      akteur,
      vorherMitglied,
      { ...vorherMitglied, role: "broadcaster", updatedAt: zeitpunkt },
      zeitpunkt,
    )).resolves.toBe(false);
    const broadcaster = {
      channelId: "kanal-a",
      userId: "kanal-a",
      role: "broadcaster" as const,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    };
    await expect(entferneBetreiberMitglied(
      datenbank as unknown as D1Database,
      akteur,
      broadcaster,
      zeitpunkt,
    )).resolves.toBe(false);
    await expect(leseAudit(datenbank)).resolves.toEqual([]);
    await expect(datenbank.prepare(
      "SELECT COUNT(*) AS count FROM channel_members WHERE channel_id = ?",
    ).bind("kanal-a").first()).resolves.toEqual({ count: 2 });
  });

  it("schreibt nach einer abgelehnten Mutation keine Audit-Zeile", async () => {
    await setzeBetreiber(datenbank);
    await insertChannel(datenbank, "kanal-a");
    await insertMember(datenbank, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(datenbank, "kanal-a", "user-2", "bediener");
    const grundlage = datenbank as unknown as D1Database;
    const rennendeDatenbank = {
      prepare: grundlage.prepare.bind(grundlage),
      batch: async (anweisungen: Parameters<D1Database["batch"]>[0]) => {
        datenbank.prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE session_id = ?",
    ).bind("2026-09-18T00:30:00.000Z", `session-${betreiberId}`).runSync();
        return grundlage.batch(anweisungen);
      },
    } as unknown as D1Database;
    umgebung = { ...umgebung, DB: rennendeDatenbank };

    const antwort = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a/mitglieder/user-2", "PATCH", {
        role: "verwalter",
      }),
      umgebung,
    );

    expect(antwort.status).toBe(409);
    await expect(leseAudit(datenbank)).resolves.toEqual([]);
    await expect(datenbank.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "bediener" });
  });

  it("löst Mitgliedernamen über die vorhandene Helix-Auflösung auf", async () => {
    await setzeBetreiber(datenbank);
    await insertChannel(datenbank, "kanal-a");
    await insertMember(datenbank, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(datenbank, "kanal-a", "user-2", "bediener");
    await setzeBotIdentität(datenbank);
    vi.mocked(fetch).mockResolvedValueOnce(antwortVonHelix([
      { id: "kanal-a", login: "alpha", display_name: "Alpha" },
      { id: "user-2", login: "helfer", display_name: "Helfer", profile_image_url: "https://cdn.example/helfer.png" },
    ]));

    const antwort = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/kanaele/kanal-a/mitglieder"),
      umgebung,
    );
    const körper = await antwort.json<{ members: Array<Record<string, unknown>> }>();

    expect(antwort.status).toBe(200);
    expect(körper.members).toEqual([
      { userId: "kanal-a", login: "alpha", displayName: "Alpha", profileImageUrl: null, role: "broadcaster", joinedAt: "2026-09-18T00:00:00.000Z" },
      { userId: "user-2", login: "helfer", displayName: "Helfer", profileImageUrl: "https://cdn.example/helfer.png", role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" },
    ]);
  });

  it("listet ausschließlich Betreiber-Audit kanalübergreifend und seitenweise", async () => {
    await setzeBetreiber(datenbank);
    await insertChannel(datenbank, "kanal-a");
    await insertMember(datenbank, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(datenbank, "kanal-a", "user-2", "bediener");
    await datenbank.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
       VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', ?)`,
    ).bind("audit-mitglied", "mitglied", "2026-09-18T00:00:01.000Z", "kanal-a", "mitglied.entfernt", "mitglied").run();
    await datenbank.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
       VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', ?)`,
    ).bind("audit-betreiber-1", "betreiber", "2026-09-18T00:00:02.000Z", "kanal-a", "mitglied.hinzugefuegt", "betreiber").run();
    await datenbank.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
       VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', ?)`,
    ).bind("audit-betreiber-2", "betreiber", "2026-09-18T00:00:03.000Z", "kanal-a", "kanal.vollzustimmung_geaendert", "betreiber").run();

    const ersteAntwort = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/audit?limit=1"),
      umgebung,
    );
    const ersteSeite = await ersteAntwort.json<{ entries: Array<Record<string, unknown>>; nextCursor: string | null }>();
    const zweiteAntwort = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, `/api/betreiber/audit?limit=1&cursor=${encodeURIComponent(ersteSeite.nextCursor ?? "")}`),
      umgebung,
    );
    const zweiteSeite = await zweiteAntwort.json<{ entries: Array<Record<string, unknown>>; nextCursor: string | null }>();

    expect(ersteSeite.entries).toHaveLength(1);
    expect(ersteSeite.entries[0]).toMatchObject({ auditId: "audit-betreiber-2", actorKind: "betreiber", channelId: "kanal-a" });
    expect(ersteSeite.nextCursor).toEqual(expect.any(String));
    expect(zweiteSeite.entries).toHaveLength(1);
    expect(zweiteSeite.entries[0]).toMatchObject({ auditId: "audit-betreiber-1", actorKind: "betreiber" });
    expect(zweiteSeite.nextCursor).toBeNull();
  });

  it("löst Betreiber-Audit-Akteure gesammelt auf und behält ungelöste IDs", async () => {
    await setzeBetreiber(datenbank);
    await insertChannel(datenbank, "kanal-a");
    await insertMember(datenbank, "kanal-a", "kanal-a", "broadcaster");
    await setzeBotIdentität(datenbank);
    await datenbank.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
       VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', ?), (?, ?, ?, ?, NULL, ?, '{}', '{}', ?)`,
    ).bind(
      "audit-aufgelöst", "betreiber", "2026-09-18T00:00:02.000Z", "kanal-a", "kanal.freigegeben", "betreiber",
      "audit-ungelöst", "gelöscht", "2026-09-18T00:00:01.000Z", "kanal-a", "kanal.vollzustimmung_geaendert", "betreiber",
    ).run();
    const twitch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe("/helix/users");
      expect(url.searchParams.getAll("id")).toEqual(["betreiber", "gelöscht"]);
      return Promise.resolve(antwortVonHelix([{ id: "betreiber", login: "esembe", display_name: "Esembe" }]));
    });
    vi.stubGlobal("fetch", twitch);

    const antwort = await betreiberRouter.fetch(
      await anfrageFür(betreiberId, "/api/betreiber/audit"),
      umgebung,
    );
    const körper = await antwort.json<{ entries: Array<Record<string, unknown>> }>();

    expect(antwort.status).toBe(200);
    expect(twitch).toHaveBeenCalledTimes(1);
    expect(körper.entries).toEqual([
      expect.objectContaining({ actorUserId: "betreiber", actorLogin: "esembe", actorDisplayName: "Esembe", actorKind: "betreiber" }),
      expect.objectContaining({ actorUserId: "gelöscht", actorLogin: null, actorDisplayName: null, actorKind: "betreiber" }),
    ]);
  });
});
