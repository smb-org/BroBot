import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAppAccessToken,
  maintainAppAccessToken,
  requestAppAccessToken,
  shouldRefreshAppAccessToken,
} from "../../src/worker/app-token";
import { TwitchApiError } from "../../src/worker/bot-maintenance";
import { decryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken } from "./fixtures";
import { TestD1Database } from "./test-d1";

const encryptionKeys = JSON.stringify({
  active: {
    id: "encryption-v1",
    key: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"),
  },
  retired: [],
});

describe("app access token", () => {
  let database: TestD1Database;
  const environment = () => ({
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: encryptionKeys,
  } as unknown as Env);

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
  });

  it("passes through a client credentials rejection as a TwitchApiError", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "invalid_client", message: "bad credentials" }),
      { status: 401 },
    ));

    const result = getAppAccessToken(
      environment(),
      "2026-09-19T10:00:00.000Z",
      fetcher,
    );
    await expect(result).rejects.toBeInstanceOf(TwitchApiError);
    await expect(result).rejects.toMatchObject({
      status: 401,
      code: "invalid_client",
    });
    await expect(database.prepare(
      "SELECT id FROM twitch_app_access_token WHERE id = 1",
    ).first()).resolves.toBeNull();
  });

  it("rejects an unexpected JSON shape with a TwitchApiError", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("null", { status: 200 }));
    const result = requestAppAccessToken(fetcher, environment());

    await expect(result).rejects.toBeInstanceOf(TwitchApiError);
    await expect(result).rejects.toMatchObject({
      status: 200,
      code: null,
    });
  });

  it("rejects a malformed JSON response as a TwitchApiError", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("kein-json", { status: 200 }));
    const result = requestAppAccessToken(fetcher, environment());

    await expect(result).rejects.toBeInstanceOf(TwitchApiError);
    await expect(result).rejects.toMatchObject({
      status: 200,
      code: null,
    });
  });

  it.each([
    ["fehlend", {}],
    ["leer", { access_token: "", expires_in: 7200 }],
    ["null", { expires_in: null }],
    ["null", { expires_in: 0 }],
    ["negativ", { expires_in: -1 }],
    ["Text", { expires_in: "7200" }],
    ["unendlich", { expires_in: Number.POSITIVE_INFINITY }],
  ])("rejects a %s expiry", async (_name, extra) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "app-access", ...extra }),
      { status: 200 },
    ));

    await expect(requestAppAccessToken(fetcher, environment())).rejects.toBeInstanceOf(TwitchApiError);
  });

  it("passes a network error through unchanged during renewal", async () => {
    const networkError = new Error("DNS fehlgeschlagen");
    const fetcher = vi.fn().mockRejectedValue(networkError);

    await expect(getAppAccessToken(
      environment(),
      "2026-09-19T10:00:00.000Z",
      fetcher,
    )).rejects.toBe(networkError);
    await expect(database.prepare(
      "SELECT id FROM twitch_app_access_token WHERE id = 1",
    ).first()).resolves.toBeNull();
  });

  it("fetches the app token via client credentials and stores it encrypted", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "app-access", expires_in: 7200, token_type: "bearer" }),
      { status: 200 },
    ));

    await expect(getAppAccessToken(
      environment(),
      "2026-09-19T10:00:00.000Z",
      fetcher,
    )).resolves.toBe("app-access");
    expect(fetcher).toHaveBeenCalledWith(
      "https://id.twitch.tv/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetcher.mock.calls[0];
    if (request === undefined || !(request[1]?.body instanceof URLSearchParams)) {
      throw new Error("Client-Credentials-Anfrage fehlt");
    }
    expect(Object.fromEntries(request[1].body)).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      grant_type: "client_credentials",
    });
    const row = await database.prepare(
      "SELECT access_token_ciphertext, expires_at FROM twitch_app_access_token WHERE id = 1",
    ).first<{ access_token_ciphertext: string; expires_at: string }>();
    expect(row).not.toBeNull();
    if (row === null) throw new Error("App-Token fehlt");
    expect(row.access_token_ciphertext).not.toContain("app-access");
    await expect(decryptJson<{ token: string }>(
      row.access_token_ciphertext,
      parseKeyRing(encryptionKeys),
    )).resolves.toEqual({ token: "app-access" });
  });

  it("maintains the app token even with the old transitional secret name", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "legacy-app-access", expires_in: 7200 }),
      { status: 200 },
    ));
    const env = {
      ...environment(),
      TOKEN_ENCRYPTION_KEYS: undefined,
      SESSION_ENCRYPTION_KEYS: encryptionKeys,
    } as unknown as Env;

    await expect(maintainAppAccessToken(env, "2026-09-19T10:00:00.000Z", fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the cache and only refreshes in the lead time before expiry", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "first", expires_in: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "second", expires_in: 7200 }), { status: 200 }));
    const env = environment();

    await expect(getAppAccessToken(env, "2026-09-19T10:00:00.000Z", fetcher)).resolves.toBe("first");
    await expect(getAppAccessToken(env, "2026-09-19T10:30:00.000Z", fetcher)).resolves.toBe("first");
    await expect(getAppAccessToken(env, "2026-09-19T11:01:00.000Z", fetcher)).resolves.toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns the full successful client credentials response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "app-access", expires_in: 7200 }),
      { status: 200 },
    ));

    await expect(requestAppAccessToken(fetcher, environment())).resolves.toEqual({
      accessToken: "app-access",
      expiresIn: 7200,
    });
  });

  it("retries a failed D1 rotation once", async () => {
    const firstError = new Error("temporärer D1-Fehler");
    const database = appTokenRotationDatabase([firstError, 1]);
    const env = { ...environment(), DB: database };
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "retried", expires_in: 7200 }),
      { status: 200 },
    ));

    await expect(getAppAccessToken(env, "2026-09-19T10:00:00.000Z", fetcher)).resolves.toBe("retried");
  });

  it("passes through the first error on two failed D1 rotations", async () => {
    const firstError = new Error("erster D1-Fehler");
    const database = appTokenRotationDatabase([firstError, new Error("zweiter D1-Fehler")]);
    const env = { ...environment(), DB: database };
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "nicht-gespeichert", expires_in: 7200 }),
      { status: 200 },
    ));

    await expect(getAppAccessToken(env, "2026-09-19T10:00:00.000Z", fetcher)).rejects.toBe(firstError);
  });

  it("reports a missing current token after a lost rotation as an error", async () => {
    const database = appTokenRotationDatabase([0, 0]);
    const env = { ...environment(), DB: database };
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "nicht-gespeichert", expires_in: 7200 }),
      { status: 200 },
    ));

    await expect(getAppAccessToken(env, "2026-09-19T10:00:00.000Z", fetcher)).rejects.toThrow(
      "App-Token konnte nach der Rotation nicht gelesen werden.",
    );
  });

  it("gives both runs the CAS winner on parallel rotation", async () => {
    let release!: () => void;
    let resolveBothStarted!: () => void;
    let started = 0;
    const bothStarted = new Promise<void>((resolve) => { resolveBothStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async () => {
      started += 1;
      const call = started;
      if (call === 2) resolveBothStarted();
      await gate;
      return new Response(
        JSON.stringify({ access_token: call === 1 ? "parallel-eins" : "parallel-zwei", expires_in: 7200 }),
        { status: 200 },
      );
    });

    const first = getAppAccessToken(environment(), "2026-09-19T10:00:00.000Z", fetcher);
    const second = getAppAccessToken(environment(), "2026-09-19T10:00:00.000Z", fetcher);
    await bothStarted;
    release();

    const values = await Promise.all([first, second]);
    expect(values[0]).toBe(values[1]);
    expect(["parallel-eins", "parallel-zwei"]).toContain(values[0]);
  });

  it("preserves the original creation time across a renewal", async () => {
    const oldCreatedAt = "2026-09-18T00:00:00.000Z";
    await insertAppAccessToken(
      database,
      "cipher-alt",
      "2026-09-19T09:00:00.000Z",
      oldCreatedAt,
      "2026-09-18T01:00:00.000Z",
    );
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "renewed", expires_in: 7200 }),
      { status: 200 },
    ));

    await expect(getAppAccessToken(environment(), "2026-09-19T10:00:00.000Z", fetcher)).resolves.toBe("renewed");
    await expect(database.prepare(
      "SELECT created_at FROM twitch_app_access_token WHERE id = 1",
    ).first<{ created_at: string }>()).resolves.toEqual({ created_at: oldCreatedAt });
  });

  it("treats unknown or expired time values as needing a refresh", () => {
    expect(shouldRefreshAppAccessToken("kein-datum", "2026-09-19T10:00:00.000Z")).toBe(true);
    expect(shouldRefreshAppAccessToken("2026-09-19T11:00:01.000Z", "2026-09-19T10:00:00.000Z")).toBe(false);
    expect(shouldRefreshAppAccessToken("2026-09-19T11:00:00.000Z", "2026-09-19T10:00:00.000Z")).toBe(true);
  });
});

const appTokenRotationDatabase = (outcomes: Array<number | Error>): D1Database => {
  let rotation = 0;
  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        first: <T>() => Promise.resolve(null as T | null),
        run: () => {
          if (!sql.includes("INSERT INTO twitch_app_access_token")) {
            return Promise.resolve({ success: true, meta: { changes: 0 } });
          }
          const outcome = outcomes[rotation++];
          if (outcome instanceof Error) return Promise.reject(outcome);
          return Promise.resolve({ success: true, meta: { changes: outcome ?? 0 } });
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
};
