import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database, type TestPreparedStatement, type TestD1Result } from "./test-d1";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

let database: TestD1Database;
let batchCalls = 0;
let rowsWritten = 0;
let originalBatch: (statements: TestPreparedStatement[]) => Promise<TestD1Result[]>;
let originalPrepare: (sql: string) => TestPreparedStatement;

const requestFor = async (userId: string, path: string, method = "GET", body?: unknown, includeCsrf = true): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie(
    { sessionId }, environmentKeys.SESSION_COOKIE_KEYS, environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrf = await createCsrfToken(sessionId, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    method,
    headers: new Headers({
      Cookie: `__Host-brobot_session=${cookie}${includeCsrf ? `; __Host-brobot_csrf=${csrf}` : ""}`,
      "Content-Type": "application/json",
      ...(includeCsrf ? { "X-CSRF-Token": csrf } : {}),
    }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

const fetchPanel = async (userId: string, path: string, method = "GET", body?: unknown, includeCsrf = true): Promise<Response> =>
  panelRouter.fetch(await requestFor(userId, path, method, body, includeCsrf), {
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "test-client-id",
    SESSION_COOKIE_KEYS: environmentKeys.SESSION_COOKIE_KEYS,
    SESSION_ENCRYPTION_KEYS: environmentKeys.SESSION_ENCRYPTION_KEYS,
  });

const element = (id: string, x = 0) => ({
  id,
  kind: "variable",
  label: "Score",
  variableName: null,
  text: "Score {value}",
  config: {},
  x,
  y: 0,
  scalePercent: 100,
  z: 0,
  inComposition: true,
});

const createOverlay = async (userId: string, channelId: string, name: string): Promise<string> => {
  const response = await fetchPanel(userId, `/api/channels/${channelId}/overlays`, "POST", { name });
  if (response.status !== 201) throw new Error(`Overlay creation failed: ${String(response.status)}`);
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Overlay response was invalid.");
  const overlay: unknown = Reflect.get(body, "overlay");
  if (overlay === null || typeof overlay !== "object" || Array.isArray(overlay)) throw new Error("Overlay response was invalid.");
  const id: unknown = Reflect.get(overlay, "id");
  if (typeof id !== "string") throw new Error("Overlay response was invalid.");
  return id;
};

const startD1WriteCapture = (): void => {
  batchCalls = 0;
  rowsWritten = 0;
  database.batch = async (statements) => {
    batchCalls += 1;
    const results = await originalBatch(statements);
    rowsWritten += results.reduce((total, result) => total + result.meta.rows_written, 0);
    return results;
  };
};

describe("stored overlay routes", () => {
  beforeEach(() => {
    database = new TestD1Database();
    originalBatch = database.batch.bind(database);
    originalPrepare = database.prepare.bind(database);
    startD1WriteCapture();
  });
  afterEach(() => { database.close(); });

  it("scopes reads by channel and denies operator writes", async () => {
    await insertChannel(database, "channel-a");
    await insertChannel(database, "channel-b");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await insertMember(database, "channel-b", "manager-a", "manager");
    await insertMember(database, "channel-a", "operator-a", "operator");

    const channelAOverlay = await createOverlay("manager-a", "channel-a", "Gameplay");
    const channelBOverlay = await createOverlay("manager-a", "channel-b", "Private");
    const crossChannel = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${channelBOverlay}`);
    expect(crossChannel.status).toBe(404);
    await expect(crossChannel.json()).resolves.toEqual({ error: "overlay_not_found" });

    const listed = await fetchPanel("manager-a", "/api/channels/channel-a/overlays");
    await expect(listed.json()).resolves.toMatchObject({ overlays: [{ id: channelAOverlay, name: "Gameplay" }] });

    const deniedCreate = await fetchPanel("operator-a", "/api/channels/channel-a/overlays", "POST", { name: "Denied" });
    const deniedSave = await fetchPanel("operator-a", `/api/channels/channel-a/overlays/${channelAOverlay}`, "PUT", {
      baseRevision: 1, name: "Gameplay", width: 1920, height: 1080, css: "", elements: [],
    });
    const deniedDelete = await fetchPanel("operator-a", `/api/channels/channel-a/overlays/${channelAOverlay}`, "DELETE");
    expect([deniedCreate.status, deniedSave.status, deniedDelete.status]).toEqual([403, 403, 403]);
  });

  it("requires the session-bound CSRF token for overlay mutations", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");

    const response = await fetchPanel("manager-a", "/api/channels/channel-a/overlays", "POST", { name: "Gameplay" }, false);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "csrf_invalid" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM overlays WHERE channel_id = 'channel-a'").first())
      .resolves.toEqual({ count: 0 });
  });

  it("uses revision CAS, diffs element rows, records rows_written, and skips unchanged drafts", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const overlayId = await createOverlay("manager-a", "channel-a", "Gameplay");

    const invalidReference = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      baseRevision: 1,
      name: "Gameplay",
      width: 1920,
      height: 1080,
      css: "",
      elements: [{ ...element("missing-variable"), variableName: "missing" }],
    });
    expect(invalidReference.status).toBe(400);
    await expect(invalidReference.json()).resolves.toEqual({ error: "overlay_data_invalid" });

    const draft = {
      baseRevision: 1,
      name: "Gameplay",
      width: 1920,
      height: 1080,
      css: "",
      elements: [element("element-a"), element("element-b", 8)],
    };
    startD1WriteCapture();
    const saved = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", draft);
    expect(saved.status).toBe(200);
    expect(rowsWritten).toBe(4); // Overlay row + two element rows + audit row.
    await expect(saved.json()).resolves.toMatchObject({ overlay: { revision: 2, elements: draft.elements } });

    startD1WriteCapture();
    const unchanged = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      ...draft,
      baseRevision: 2,
      elements: [element("element-b", 8), element("element-a")],
    });
    expect(unchanged.status).toBe(200);
    expect(batchCalls).toBe(0);
    expect(rowsWritten).toBe(0);

    const auditBefore = await database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'overlay.updated'")
      .first<{ count: number }>();
    startD1WriteCapture();
    const stale = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", draft);
    expect(stale.status).toBe(409);
    expect(batchCalls).toBe(0);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'overlay.updated'")
      .first()).resolves.toEqual(auditBefore);

    startD1WriteCapture();
    const changed = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      ...draft,
      baseRevision: 2,
      elements: [element("element-a", 1), element("element-b", 8)],
    });
    expect(changed.status).toBe(200);
    expect(rowsWritten).toBe(3); // Overlay row + one changed element + audit row.

    startD1WriteCapture();
    const removedElement = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      ...draft,
      baseRevision: 3,
      elements: [element("element-a", 1)],
    });
    expect(removedElement.status).toBe(200);
    expect(rowsWritten).toBe(3); // Overlay row + deleted element row + audit row.
    await expect(database.prepare(
      "SELECT element_id FROM overlay_elements WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).all()).resolves.toMatchObject({ results: [{ element_id: "element-a" }] });

    const deleted = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "DELETE");
    expect(deleted.status).toBe(204);
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM overlay_elements WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ count: 0 });
  });

  it("rechecks the managing role in SQL after the request was authorized", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const overlayId = await createOverlay("manager-a", "channel-a", "Gameplay");
    startD1WriteCapture();

    let roleChanged = false;
    database.prepare = (sql) => {
      if (!roleChanged && sql.includes("UPDATE overlays") && sql.includes("revision = revision + 1")) {
        roleChanged = true;
        database.sqlite.prepare(
          "UPDATE channel_members SET role = 'operator' WHERE channel_id = 'channel-a' AND user_id = 'manager-a'",
        ).run();
      }
      return originalPrepare(sql);
    };

    const response = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      baseRevision: 1,
      name: "Renamed",
      width: 1920,
      height: 1080,
      css: "",
      elements: [element("element-a")],
    });

    expect(roleChanged).toBe(true);
    expect(response.status).toBe(403);
    expect(rowsWritten).toBe(0);
    await expect(database.prepare(
      "SELECT name, revision FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ name: "Gameplay", revision: 1 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'overlay.updated'").first())
      .resolves.toEqual({ count: 0 });
  });

  it("keeps a concurrent revision loss from partially writing elements or audit", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const overlayId = await createOverlay("manager-a", "channel-a", "Gameplay");
    startD1WriteCapture();

    let raced = false;
    database.prepare = (sql) => {
      if (!raced && sql.includes("UPDATE overlays") && sql.includes("revision = revision + 1")) {
        raced = true;
        database.sqlite.prepare(
          "UPDATE overlays SET name = 'Concurrent', revision = 2 WHERE channel_id = 'channel-a' AND overlay_id = ?",
        ).run(overlayId);
      }
      return originalPrepare(sql);
    };

    const response = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      baseRevision: 1,
      name: "Stale draft",
      width: 1920,
      height: 1080,
      css: "",
      elements: [element("element-a")],
    });

    expect(raced).toBe(true);
    expect(response.status).toBe(409);
    expect(rowsWritten).toBe(0);
    await expect(database.prepare(
      "SELECT name, revision FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ name: "Concurrent", revision: 2 });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM overlay_elements WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'overlay.updated'").first())
      .resolves.toEqual({ count: 0 });
  });

  it("enforces the channel and per-overlay element limits", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const createdAt = "2026-09-24T00:00:00.000Z";
    for (let index = 0; index < 20; index += 1) {
      await database.prepare(
        "INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at) VALUES (?, 'channel-a', ?, ?, ?)",
      ).bind(`overlay-${String(index)}`, `Overlay ${String(index)}`, createdAt, createdAt).run();
    }
    const overChannelLimit = await fetchPanel("manager-a", "/api/channels/channel-a/overlays", "POST", { name: "21st" });
    expect(overChannelLimit.status).toBe(409);
    await expect(overChannelLimit.json()).resolves.toEqual({ error: "overlay_limit_reached" });

    const elements = Array.from({ length: 21 }, (_, index) => element(`element-${String(index)}`));
    const overElementLimit = await fetchPanel("manager-a", "/api/channels/channel-a/overlays/overlay-0", "PUT", {
      baseRevision: 1,
      name: "Overlay 0",
      width: 1920,
      height: 1080,
      css: "",
      elements,
    });
    expect(overElementLimit.status).toBe(409);
    await expect(overElementLimit.json()).resolves.toEqual({ error: "overlay_element_limit_reached" });
  });
});
