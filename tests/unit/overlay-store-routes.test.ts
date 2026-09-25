import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { hashOverlayToken } from "../../src/worker/auth/crypto";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import type { RealtimeMessage } from "../../src/realtime-contract";
import { apiErrorTexts } from "../../src/dashboard/locale";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database, type TestPreparedStatement, type TestD1Result } from "./test-d1";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
  OVERLAY_TOKEN_PEPPER: key(4),
};

let database: TestD1Database;
let batchCalls = 0;
let sqliteChanges = 0;
let originalBatch: (statements: TestPreparedStatement[]) => Promise<TestD1Result[]>;
let originalPrepare: (sql: string) => TestPreparedStatement;
let realtimePublish: ReturnType<typeof vi.fn<(messages: readonly RealtimeMessage[]) => void>>;
let realtimeLegacySocketClose: ReturnType<typeof vi.fn<(tokenId: string) => Promise<boolean>>>;

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
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: () => ({ publish: realtimePublish, closeUnboundOverlayTokenSockets: realtimeLegacySocketClose }),
  },
    TWITCH_CLIENT_ID: "test-client-id",
    SESSION_COOKIE_KEYS: environmentKeys.SESSION_COOKIE_KEYS,
    SESSION_ENCRYPTION_KEYS: environmentKeys.SESSION_ENCRYPTION_KEYS,
    OVERLAY_TOKEN_PEPPER: environmentKeys.OVERLAY_TOKEN_PEPPER,
  });

const insertLegacyToken = async (channelId: string, tokenId: string, token: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO overlay_tokens (token_id, channel_id, token_hash, created_at)
     VALUES (?, ?, ?, '2026-09-24T10:00:00.000Z')`,
  ).bind(tokenId, channelId, await hashOverlayToken(token, environmentKeys.OVERLAY_TOKEN_PEPPER)).run();
};

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
  sqliteChanges = 0;
  database.batch = async (statements) => {
    batchCalls += 1;
    const results = await originalBatch(statements);
    sqliteChanges += results.reduce((total, result) => total + result.meta.changes, 0);
    return results;
  };
};

describe("stored overlay routes", () => {
  beforeEach(() => {
    database = new TestD1Database();
    realtimePublish = vi.fn<(messages: readonly RealtimeMessage[]) => void>();
    realtimeLegacySocketClose = vi.fn<(tokenId: string) => Promise<boolean>>().mockResolvedValue(true);
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

  it("creates a new overlay and its first variable element atomically", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const variable = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 1, description: "Score", resetOnStreamStart: false,
    });
    expect(variable.status).toBe(201);
    const initialElement = { ...element("first-element"), variableName: "score", text: "score: {value}" };

    const created = await fetchPanel("manager-a", "/api/channels/channel-a/overlays", "POST", {
      name: "Gameplay", width: 1920, height: 1080, initialElement,
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ overlay: { id: string; revision: number; elements: Array<{ variableName: string }> } }>();
    expect(createdBody.overlay).toMatchObject({ revision: 1, elements: [{ variableName: "score" }] });

    const duplicateElementCreate = await fetchPanel("manager-a", "/api/channels/channel-a/overlays", "POST", {
      name: "Must roll back", width: 1920, height: 1080, initialElement,
    });
    expect(duplicateElementCreate.status).toBeGreaterThanOrEqual(400);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM overlays WHERE channel_id = 'channel-a'").first())
      .resolves.toEqual({ count: 1 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM overlay_elements WHERE channel_id = 'channel-a'").first())
      .resolves.toEqual({ count: 1 });
  });

  it("imports an active legacy link into one overlay and binds its token atomically", async () => {
    await insertChannel(database, "channel-a");
    await insertChannel(database, "channel-b");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await insertMember(database, "channel-b", "manager-a", "manager");
    await insertMember(database, "channel-a", "operator-a", "operator");
    const createdVariable = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 12, description: "Score", resetOnStreamStart: false,
    });
    expect(createdVariable.status).toBe(201);

    const channelToken = "a".repeat(43);
    const otherChannelToken = "b".repeat(43);
    const operatorToken = "c".repeat(43);
    await insertLegacyToken("channel-a", "legacy-a", channelToken);
    await insertLegacyToken("channel-b", "legacy-b", otherChannelToken);
    await insertLegacyToken("channel-a", "legacy-c", operatorToken);

    const importPath = "/api/channels/channel-a/overlays/import-legacy";
    const crossChannel = await fetchPanel("manager-a", importPath, "POST", {
      token: otherChannelToken, variableName: "score", text: "Imported: {value}",
    });
    expect(crossChannel.status).toBe(404);
    await expect(crossChannel.json()).resolves.toEqual({ error: "overlay_token_not_found" });

    const operatorImport = await fetchPanel("operator-a", importPath, "POST", {
      token: operatorToken, variableName: "score", text: "Imported: {value}",
    });
    expect(operatorImport.status).toBe(403);

    const imported = await fetchPanel("manager-a", importPath, "POST", {
      token: channelToken, variableName: "score", text: "Stored: {value}",
    });
    expect(imported.status).toBe(201);
    expect(realtimeLegacySocketClose).toHaveBeenCalledWith("legacy-a");
    const body: { overlay: { id: string; name: string; width: number; height: number; elements: Array<Record<string, unknown>> } } = await imported.json();
    expect(body.overlay).toMatchObject({ name: "score", width: 1920, height: 1080 });
    expect(body.overlay.elements).toEqual([expect.objectContaining({
      kind: "variable", label: "score", variableName: "score", text: "Stored: {value}",
      x: 0, y: 0, scalePercent: 100, z: 0, inComposition: true,
    })]);

    const binding = await database.prepare(
      "SELECT overlay_id, label, secret_envelope FROM overlay_tokens WHERE token_id = 'legacy-a'",
    ).first();
    expect(binding).toEqual({ overlay_id: body.overlay.id, label: "score", secret_envelope: null });
    const audit = await database.prepare(
      "SELECT action, after_json FROM audit_log WHERE action = 'overlay.legacy.imported'",
    ).first<{ action: string; after_json: string }>();
    expect(audit?.action).toBe("overlay.legacy.imported");
    expect(JSON.parse(audit?.after_json ?? "{}") as Record<string, unknown>).toMatchObject({
      overlayId: body.overlay.id, elementId: body.overlay.elements[0]?.id, tokenId: "legacy-a", variableName: "score",
    });
    expect(audit?.after_json).not.toContain(channelToken);

    const repeated = await fetchPanel("manager-a", importPath, "POST", {
      token: channelToken, variableName: "score", text: "Changed fragment: {value}",
    });
    expect(repeated.status).toBe(409);
    await expect(repeated.json()).resolves.toEqual({ error: "overlay_token_already_bound" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM overlays WHERE channel_id = 'channel-a'").first())
      .resolves.toEqual({ count: 1 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'overlay.legacy.imported'").first())
      .resolves.toEqual({ count: 1 });
  });

  it.each([
    ["without a placeholder", "Score"],
    ["with multiple placeholders", "Score {value} and {value}"],
  ])("keeps legacy display text %s valid when an imported draft is saved", async (_description, legacyText) => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 12, description: "Score", resetOnStreamStart: false,
    });
    const token = "d".repeat(43);
    await insertLegacyToken("channel-a", "legacy-display-text", token);

    const imported = await fetchPanel("manager-a", "/api/channels/channel-a/overlays/import-legacy", "POST", {
      token, variableName: "score", text: legacyText,
    });
    const body = await imported.json<{
      overlay: { id: string; elements: Array<Record<string, unknown>> };
    }>();
    const savedElement = body.overlay.elements[0];
    if (savedElement === undefined) throw new Error("Imported overlay element was missing.");
    const firstElement = {
      id: savedElement.id,
      kind: savedElement.kind,
      label: savedElement.label,
      variableName: savedElement.variableName,
      text: savedElement.text,
      config: savedElement.config,
      x: savedElement.x,
      y: savedElement.y,
      scalePercent: savedElement.scalePercent,
      z: savedElement.z,
      inComposition: savedElement.inComposition,
    };
    const saved = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${body.overlay.id}`, "PUT", {
      baseRevision: 1,
      name: "Updated imported overlay",
      width: 1920,
      height: 1080,
      css: "",
      elements: [firstElement, { ...element("second-element"), variableName: "score" }],
    });
    const savedBody = await saved.json<{ overlay: { elements: Array<{ text: string }> } }>();

    expect(imported.status).toBe(201);
    expect(saved.status).toBe(200);
    expect(savedBody.overlay.elements.map(({ text }) => text)).toEqual([legacyText, "Score {value}"]);
  });

  it("rejects reconnect when the server already has another variable bound to the element", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    for (const name of ["score", "other"]) {
      const result = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
        name, value: 1, description: name, resetOnStreamStart: false,
      });
      expect(result.status).toBe(201);
    }
    const overlayId = await createOverlay("manager-a", "channel-a", "Gameplay");
    const currentElement = { ...element("element-a"), variableName: "other", text: "other: {value}" };
    const currentSave = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      baseRevision: 1, name: "Gameplay", width: 1920, height: 1080, css: "", elements: [currentElement],
    });
    expect(currentSave.status).toBe(200);

    const staleReconnect = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      baseRevision: 2,
      name: "Gameplay",
      width: 1920,
      height: 1080,
      css: "",
      elements: [{ ...currentElement, variableName: "score", text: "score: {value}" }],
      reconnectExpectation: { elementId: "element-a", missingVariableName: "score" },
    });

    expect(staleReconnect.status).toBe(409);
    await expect(staleReconnect.json()).resolves.toMatchObject({ error: "overlay_changed_concurrently" });
    await expect(database.prepare("SELECT variable_name FROM overlay_elements WHERE element_id = 'element-a'").first())
      .resolves.toEqual({ variable_name: "other" });
  });

  it("publishes the created, saved, and deleted overlay revisions", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const overlayId = await createOverlay("manager-a", "channel-a", "Gameplay");

    const saved = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      baseRevision: 1, name: "Gameplay", width: 1920, height: 1080, css: ".brobot-overlay {}", elements: [],
    });
    const deleted = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "DELETE", {
      baseRevision: 2,
    });

    expect([saved.status, deleted.status]).toEqual([200, 204]);
    expect(realtimePublish.mock.calls.map(([messages]) => messages)).toMatchObject([
      [{ type: "overlay.changed", payload: { overlayId, revision: 1 } }],
      [{ type: "overlay.changed", payload: { overlayId, revision: 2 } }],
      [{ type: "overlay.changed", payload: { overlayId, revision: 2 } }],
    ]);
  });

  it("rejects imported or remote custom CSS when saving and reports localized errors", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const overlayId = await createOverlay("manager-a", "channel-a", "Gameplay");
    const draft = (css: string) => ({
      baseRevision: 1, name: "Gameplay", width: 1920, height: 1080, css, elements: [],
    });

    const imported = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT",
      draft('@import "./theme.css"; .brobot-overlay { color: white; }'));
    const remote = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT",
      draft('.brobot-overlay { background: url("https://assets.example/image.png"); }'));
    const relative = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT",
      draft('.brobot-overlay { background: url("../assets/image.png"); }'));

    expect(imported.status).toBe(400);
    await expect(imported.json()).resolves.toEqual({ error: "overlay_css_invalid" });
    expect(remote.status).toBe(400);
    await expect(remote.json()).resolves.toEqual({ error: "overlay_css_invalid" });
    expect(relative.status).toBe(200);
    expect(apiErrorTexts.de.overlay_css_invalid).toContain("Overlay-CSS");
    expect(apiErrorTexts.en.overlay_css_invalid).toContain("Overlay CSS");
  });

  it("uses revision CAS, diffs element rows, checks SQLite changes, and skips unchanged drafts", async () => {
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

    const oversizedConfig = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      baseRevision: 1,
      name: "Gameplay",
      width: 1920,
      height: 1080,
      css: "",
      elements: [{ ...element("oversized-config"), config: { payload: "€".repeat(1_400) } }],
    });
    expect(oversizedConfig.status).toBe(400);
    await expect(oversizedConfig.json()).resolves.toEqual({ error: "overlay_data_invalid" });

    const draft = {
      baseRevision: 1,
      name: "Gameplay",
      width: 1920,
      height: 1080,
      css: "css-secret",
      elements: [{ ...element("element-a"), config: { token: "config-secret" } }, element("element-b", 8)],
    };
    startD1WriteCapture();
    const saved = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", draft);
    expect(saved.status).toBe(200);
    expect(sqliteChanges).toBe(4); // SQLite changes: overlay row + two element rows + audit row.
    await expect(saved.json()).resolves.toMatchObject({ overlay: { revision: 2, elements: draft.elements } });
    const firstAudit = await database.prepare(
      "SELECT after_json FROM audit_log WHERE action = 'overlay.updated'",
    ).first<{ after_json: string }>();
    const firstAuditAfter = JSON.parse(firstAudit?.after_json ?? "{}") as Record<string, unknown>;
    expect(firstAuditAfter).toMatchObject({ elementChanges: {
      added: [{ id: "element-a", label: "Score" }, { id: "element-b", label: "Score" }],
      changed: [],
      removed: [],
    } });
    expect(firstAudit?.after_json).not.toContain("config-secret");
    expect(firstAudit?.after_json).not.toContain("css-secret");
    expect(firstAudit?.after_json).not.toContain("token");
    expect(firstAuditAfter).not.toHaveProperty("css");

    startD1WriteCapture();
    const unchanged = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      ...draft,
      baseRevision: 2,
      elements: [element("element-b", 8), { ...element("element-a"), config: { token: "config-secret" } }],
    });
    expect(unchanged.status).toBe(200);
    expect(batchCalls).toBe(0);
    expect(sqliteChanges).toBe(0);

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
      elements: [{ ...element("element-a", 1), label: "Deaths", config: { token: "config-secret" } }, element("element-b", 8)],
    });
    expect(changed.status).toBe(200);
    expect(sqliteChanges).toBe(3); // SQLite changes: overlay row + one changed element + audit row.
    const changedAudit = await database.prepare(
      "SELECT after_json FROM audit_log WHERE action = 'overlay.updated' ORDER BY rowid DESC LIMIT 1",
    ).first<{ after_json: string }>();
    expect(JSON.parse(changedAudit?.after_json ?? "{}") as Record<string, unknown>).toMatchObject({
      elementChanges: { added: [], changed: [{ id: "element-a", beforeLabel: "Score", afterLabel: "Deaths" }], removed: [] },
    });

    startD1WriteCapture();
    const removedElement = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      ...draft,
      baseRevision: 3,
      elements: [{ ...element("element-a", 1), label: "Deaths", config: { token: "config-secret" } }],
    });
    expect(removedElement.status).toBe(200);
    expect(sqliteChanges).toBe(3); // SQLite changes: overlay row + deleted element row + audit row.
    const finalAudit = await database.prepare(
      "SELECT after_json FROM audit_log WHERE action = 'overlay.updated' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).first<{ after_json: string }>();
    expect(JSON.parse(finalAudit?.after_json ?? "{}") as Record<string, unknown>).toMatchObject({
      elementChanges: { added: [], changed: [], removed: [{ id: "element-b", label: "Score" }] },
    });
    await expect(database.prepare(
      "SELECT element_id FROM overlay_elements WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).all()).resolves.toMatchObject({ results: [{ element_id: "element-a" }] });

    const deleted = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "DELETE", { baseRevision: 4 });
    expect(deleted.status).toBe(204);
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM overlay_elements WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ count: 0 });
  });

  it("returns a conflict instead of colliding element ids across overlays", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const firstOverlayId = await createOverlay("manager-a", "channel-a", "First");
    const secondOverlayId = await createOverlay("manager-a", "channel-a", "Second");
    const draft = {
      baseRevision: 1,
      name: "First",
      width: 1920,
      height: 1080,
      css: "",
      elements: [element("shared-element-id")],
    };
    const firstSave = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${firstOverlayId}`, "PUT", draft);
    expect(firstSave.status).toBe(200);

    startD1WriteCapture();
    const collision = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${secondOverlayId}`, "PUT", {
      ...draft,
      name: "Second",
    });
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toEqual({ error: "overlay_element_id_conflict" });
    expect(sqliteChanges).toBe(0);
    await expect(database.prepare(
      "SELECT revision FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(secondOverlayId).first()).resolves.toEqual({ revision: 1 });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM overlay_elements WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(secondOverlayId).first()).resolves.toEqual({ count: 0 });
  });

  it("returns a conflict instead of a 500 when a referenced variable is deleted mid-save", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
       VALUES ('channel-a', 'score', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();
    const overlayId = await createOverlay("manager-a", "channel-a", "Gameplay");
    startD1WriteCapture();

    let raced = false;
    database.prepare = (sql) => {
      if (!raced && sql.includes("UPDATE overlays") && sql.includes("revision = revision + 1")) {
        raced = true;
        database.sqlite.prepare(
          "DELETE FROM channel_variables WHERE channel_id = 'channel-a' AND name = 'score'",
        ).run();
      }
      return originalPrepare(sql);
    };

    const response = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", {
      baseRevision: 1,
      name: "Gameplay",
      width: 1920,
      height: 1080,
      css: "",
      elements: [{ ...element("element-a"), variableName: "score" }],
    });

    expect(raced).toBe(true);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "overlay_data_invalid" });
    expect(sqliteChanges).toBe(0);
    await expect(database.prepare(
      "SELECT revision FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ revision: 1 });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM overlay_elements WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'overlay.updated'").first())
      .resolves.toEqual({ count: 0 });
  });

  it("requires a base revision and preserves an overlay changed before DELETE", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const overlayId = await createOverlay("manager-a", "channel-a", "Gameplay");

    const missingRevision = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "DELETE");
    expect(missingRevision.status).toBe(400);

    let raced = false;
    database.prepare = (sql) => {
      if (!raced && sql.includes("DELETE FROM overlays")) {
        raced = true;
        database.sqlite.prepare(
          "UPDATE overlays SET revision = 2 WHERE channel_id = 'channel-a' AND overlay_id = ?",
        ).run(overlayId);
      }
      return originalPrepare(sql);
    };
    const response = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "DELETE", {
      baseRevision: 1,
    });

    expect(raced).toBe(true);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "overlay_changed_concurrently", currentRevision: 2 });
    await expect(database.prepare(
      "SELECT revision FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ revision: 2 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'overlay.deleted'").first())
      .resolves.toEqual({ count: 0 });
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
    expect(sqliteChanges).toBe(0);
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
    expect(sqliteChanges).toBe(0);
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
