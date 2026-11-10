import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { createOverlayAlertsRoutes } from "../../src/modules/overlay_alerts/routes";
import { detectMediaType } from "../../src/modules/overlay_alerts/domain/media";
import { authRouter } from "../../src/worker/auth/routes";
import { hashOverlayToken } from "../../src/worker/auth/crypto";
import { authorizeModuleManagementMutation } from "../../src/worker/module-authorization";
import { TestD1Database } from "./test-d1";

const channelId = "media_channel_a";
const otherChannelId = "media_channel_b";
const operatorId = "media_operator";
const viewerId = "media_viewer";
const now = "2026-11-10T12:00:00.000Z";
const overlayPepper = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const fixtureBytes = {
  "image/png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
  "image/gif": new TextEncoder().encode("GIF89a\x00\x00"),
  "image/webp": new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
  "audio/mpeg": new TextEncoder().encode("ID3\x04\x00\x00\x00\x00\x00\x00"),
  "audio/ogg": new TextEncoder().encode("OggS\x00\x02\x00\x00"),
  "audio/wav": new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]),
} as const;

interface TestMediaAsset {
  id: string;
  kind: "image" | "sound";
  mimeType: string;
  byteSize: number;
  sha256: string;
  fileName: string;
  createdAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readMediaAsset = async (response: Response): Promise<TestMediaAsset> => {
  const payload: unknown = await response.json();
  const asset = isRecord(payload) && isRecord(payload.asset) ? payload.asset : null;
  if (asset === null || typeof asset.id !== "string" ||
    (asset.kind !== "image" && asset.kind !== "sound") || typeof asset.mimeType !== "string" ||
    typeof asset.byteSize !== "number" || typeof asset.sha256 !== "string" ||
    typeof asset.fileName !== "string" || typeof asset.createdAt !== "string") {
    throw new Error("Media response did not contain valid asset metadata.");
  }
  return {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    fileName: asset.fileName,
    createdAt: asset.createdAt,
  };
};

const readMediaAssets = async (response: Response): Promise<Record<string, unknown>[]> => {
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.assets) || !payload.assets.every(isRecord)) {
    throw new Error("Media response did not contain an asset list.");
  }
  return payload.assets;
};

let database: TestD1Database;

const addChannel = async (db: TestD1Database, id: string): Promise<void> => {
  await db.prepare(
    "INSERT INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, id, id, now, now).run();
  await db.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'overlay_alerts', 0, '{}')",
  ).bind(id).run();
};

const addMember = async (db: TestD1Database, id: string): Promise<void> => {
  await db.prepare(
    "INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(channelId, id, "operator", now, now).run();
};

const createApp = (routes = createOverlayAlertsRoutes()) => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    const userId = context.req.header("x-test-user") === viewerId ? viewerId : operatorId;
    context.set("channelRole", "operator");
    context.set("actor", { userId, sessionId: "session-" + userId });
    context.set("authorizeMutation", (targetChannelId, actor) => ({
      sql: "AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?)",
      values: [targetChannelId, actor.userId],
    }));
    context.set("authorizeManagementMutation", authorizeModuleManagementMutation);
    context.set("prepareModuleAudit", () => database.prepare("SELECT 1") as unknown as D1PreparedStatement);
    context.set("writeModuleAudit", () => Promise.resolve());
    await next();
  });
  app.route("/api/channels/:channelId/modules/overlay_alerts", routes);
  return app;
};

const request = async (
  path: string,
  options: {
    method?: string;
    userId?: string;
    bytes?: Uint8Array;
    mimeType?: string;
    fileName?: string;
    routes?: ReturnType<typeof createOverlayAlertsRoutes>;
  } = {},
): Promise<Response> => {
  const headers = new Headers();
  if (options.userId !== undefined) headers.set("x-test-user", options.userId);
  if (options.mimeType !== undefined) headers.set("Content-Type", options.mimeType);
  if (options.fileName !== undefined) headers.set("X-File-Name", options.fileName);
  const method = options.method ?? "GET";
  let body: ArrayBuffer | undefined;
  if (options.bytes !== undefined) {
    body = new ArrayBuffer(options.bytes.byteLength);
    new Uint8Array(body).set(options.bytes);
  }
  return createApp(options.routes).fetch(new Request(
    "http://localhost/api/channels/" + channelId + "/modules/overlay_alerts" + path,
    { method, headers, ...(body === undefined ? {} : { body }) },
  ), { DB: database as unknown as D1Database });
};

const upload = async (
  bytes: Uint8Array = fixtureBytes["image/png"],
  mimeType = "image/png",
  userId = operatorId,
): Promise<Response> => request("/media", {
  method: "POST", bytes, mimeType, userId, fileName: "sample.png",
});

describe("overlay alert media type validation", () => {
  it.each([
    ["image/png", "image", fixtureBytes["image/png"]],
    ["image/gif", "image", fixtureBytes["image/gif"]],
    ["image/webp", "image", fixtureBytes["image/webp"]],
    ["audio/mpeg", "sound", fixtureBytes["audio/mpeg"]],
    ["audio/ogg", "sound", fixtureBytes["audio/ogg"]],
    ["audio/wav", "sound", fixtureBytes["audio/wav"]],
  ] as const)("accepts %s only when its signature matches", (mimeType, kind, bytes) => {
    expect(detectMediaType(bytes, mimeType)).toEqual({ mimeType, kind });
  });

  it.each(["image/png", "image/gif", "image/webp", "audio/mpeg", "audio/ogg", "audio/wav"] as const)(
    "rejects bytes without a valid %s signature",
    (mimeType) => { expect(detectMediaType(new Uint8Array([0, 1, 2, 3]), mimeType)).toBeNull(); },
  );

  it("rejects a valid signature declared as a different allowed type", () => {
    expect(detectMediaType(fixtureBytes["image/png"], "image/gif")).toBeNull();
  });
});

describe("overlay alert media routes", () => {
  beforeEach(async () => {
    database = new TestD1Database();
    await addChannel(database, channelId);
    await addChannel(database, otherChannelId);
    await addMember(database, operatorId);
  });

  afterEach(() => { database.close(); });

  it("rejects raw uploads larger than one mebibyte", async () => {
    const bytes = new Uint8Array(1_048_577);
    bytes.set(fixtureBytes["image/png"]);

    const response = await upload(bytes);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "media_too_large" });
  });

  it("returns the existing channel asset for a duplicate content hash", async () => {
    const firstResponse = await upload();
    const first = await readMediaAsset(firstResponse);
    const duplicateResponse = await request("/media", {
      method: "POST", bytes: fixtureBytes["image/png"], mimeType: "image/png", fileName: "renamed.png",
    });
    const duplicate = await readMediaAsset(duplicateResponse);
    const count = database.sqlite.prepare("SELECT COUNT(*) AS count FROM media_assets WHERE channel_id = ?")
      .get(channelId) as { count: number };

    expect(firstResponse.status).toBe(201);
    expect(duplicateResponse.status).toBe(200);
    expect(duplicate).toEqual(first);
    expect(count.count).toBe(1);
  });

  it("accepts multipart uploads with one file field", async () => {
    const boundary = "media-upload-test-boundary";
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="multipart.png"\r\nContent-Type: image/png\r\n\r\n`,
    );
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(prefix.byteLength + fixtureBytes["image/png"].byteLength + suffix.byteLength);
    body.set(prefix);
    body.set(fixtureBytes["image/png"], prefix.byteLength);
    body.set(suffix, prefix.byteLength + fixtureBytes["image/png"].byteLength);
    const requestBody = new ArrayBuffer(body.byteLength);
    new Uint8Array(requestBody).set(body);
    const response = await createApp().fetch(new Request(
      "http://localhost/api/channels/" + channelId + "/modules/overlay_alerts/media",
      { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: requestBody },
    ), { DB: database as unknown as D1Database });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ asset: { fileName: "multipart.png", mimeType: "image/png" } });
  });

  it("rejects a channel upload after the two hundred asset limit", async () => {
    const insert = database.sqlite.prepare(
      "INSERT INTO media_assets (channel_id, id, kind, mime_type, byte_size, sha256, file_name, data, created_at) VALUES (?, ?, 'image', 'image/png', 1, ?, 'seed.png', ?, ?)",
    );
    for (let index = 0; index < 200; index += 1) {
      insert.run(channelId, "asset-" + String(index), index.toString(16).padStart(64, "0"), Buffer.from([137]), now);
    }

    const response = await upload(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "media_limit_reached" });
  });

  it("blocks deletion when the alert action reports a media reference", async () => {
    const created = await readMediaAsset(await upload());
    const routes = createOverlayAlertsRoutes({ isMediaInUse: () => Promise.resolve(true) });

    const response = await request("/media/" + created.id, { method: "DELETE", routes });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "media_in_use" });
  });

  it("serves immutable bytes only for the matching hash and channel", async () => {
    const created = await readMediaAsset(await upload());
    const path = "/media/" + created.id + "/" + created.sha256;
    const response = await request(path);
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect([...bytes]).toEqual([...fixtureBytes["image/png"]]);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await request("/media/" + created.id + "/" + "0".repeat(64))).status).toBe(404);

    const foreign = await createApp().fetch(new Request(
      "http://localhost/api/channels/" + otherChannelId + "/modules/overlay_alerts" + path,
    ), { DB: database as unknown as D1Database });
    expect(foreign.status).toBe(404);
  });

  it("serves media to the channel bound to an authenticated overlay token", async () => {
    const created = await readMediaAsset(await upload());
    const token = "media-overlay-token";
    await database.prepare(
      `INSERT INTO overlay_tokens (token_id, channel_id, token_hash, expires_at, created_at, last_used_at)
       VALUES ('media-token-a', ?, ?, NULL, ?, ?)`,
    ).bind(channelId, await hashOverlayToken(token, overlayPepper), now, new Date().toISOString()).run();
    await database.prepare(
      `INSERT INTO media_assets (channel_id, id, kind, mime_type, byte_size, sha256, file_name, data, created_at)
       VALUES (?, 'foreign-asset', 'image', 'image/png', ?, ?, 'foreign.png', ?, ?)`,
    ).bind(otherChannelId, fixtureBytes["image/png"].byteLength, "c".repeat(64), fixtureBytes["image/png"], now).run();

    const response = await authRouter.fetch(new Request(
      "https://brobot.example/api/overlay/media/" + created.id + "/" + created.sha256,
      { headers: { Authorization: `Bearer ${token}` } },
    ), { DB: database as unknown as D1Database, OVERLAY_TOKEN_PEPPER: overlayPepper });
    const foreignResponse = await authRouter.fetch(new Request(
      "https://brobot.example/api/overlay/media/foreign-asset/" + "c".repeat(64),
      { headers: { Authorization: `Bearer ${token}` } },
    ), { DB: database as unknown as D1Database, OVERLAY_TOKEN_PEPPER: overlayPepper });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixtureBytes["image/png"]);
    expect(foreignResponse.status).toBe(404);
  });

  it("lists metadata without returning bytes or writing", async () => {
    await upload();
    const before = (database.sqlite.prepare("SELECT total_changes() AS value").get() as { value: number }).value;

    const response = await request("/media");
    const assets = await readMediaAssets(response);
    const after = (database.sqlite.prepare("SELECT total_changes() AS value").get() as { value: number }).value;

    expect(response.status).toBe(200);
    expect(assets).toHaveLength(1);
    expect(assets[0]).not.toHaveProperty("data");
    expect(after).toBe(before);
  });

  it("allows operator uploads", async () => {
    const response = await upload(fixtureBytes["image/png"], "image/png", operatorId);
    expect(response.status).toBe(201);
  });

  it("rejects uploads when the actor is no longer a channel member", async () => {
    const response = await upload(fixtureBytes["image/png"], "image/png", viewerId);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "media_management_denied" });
  });

  it("keeps both GET routes read-only", async () => {
    const created = await readMediaAsset(await upload());
    const before = (database.sqlite.prepare("SELECT total_changes() AS value").get() as { value: number }).value;

    await request("/media");
    await request("/media/" + created.id + "/" + created.sha256);

    const after = (database.sqlite.prepare("SELECT total_changes() AS value").get() as { value: number }).value;
    expect(after).toBe(before);
  });
});
