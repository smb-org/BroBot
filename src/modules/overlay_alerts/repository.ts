import type { MediaAssetMetadata } from "./contracts";

export const OVERLAY_ALERTS_MODULE_ID = "overlay_alerts";

export interface StoredMediaAsset extends MediaAssetMetadata {
  channelId: string;
  data: Uint8Array;
}

interface MediaAssetRow {
  channel_id: string;
  id: string;
  kind: MediaAssetMetadata["kind"];
  mime_type: MediaAssetMetadata["mimeType"];
  byte_size: number;
  sha256: string;
  file_name: string;
  created_at: string;
  data?: ArrayBuffer | Uint8Array;
}

const toMetadata = (row: MediaAssetRow): MediaAssetMetadata => ({
  id: row.id,
  kind: row.kind,
  mimeType: row.mime_type,
  byteSize: row.byte_size,
  sha256: row.sha256,
  fileName: row.file_name,
  createdAt: row.created_at,
});

export const listMediaAssets = async (db: D1Database, channelId: string): Promise<MediaAssetMetadata[]> => {
  const result = await db.prepare(
    `SELECT channel_id, id, kind, mime_type, byte_size, sha256, file_name, created_at
       FROM media_assets
      WHERE channel_id = ?
      ORDER BY created_at DESC, id`,
  ).bind(channelId).all<MediaAssetRow>();
  return result.results.map(toMetadata);
};

export const findMediaAsset = async (
  db: D1Database,
  channelId: string,
  id: string,
): Promise<MediaAssetMetadata | null> => {
  const row = await db.prepare(
    `SELECT channel_id, id, kind, mime_type, byte_size, sha256, file_name, created_at
       FROM media_assets WHERE channel_id = ? AND id = ?`,
  ).bind(channelId, id).first<MediaAssetRow>();
  return row === null ? null : toMetadata(row);
};

export const findMediaAssetByHash = async (
  db: D1Database,
  channelId: string,
  sha256: string,
): Promise<MediaAssetMetadata | null> => {
  const row = await db.prepare(
    `SELECT channel_id, id, kind, mime_type, byte_size, sha256, file_name, created_at
       FROM media_assets WHERE channel_id = ? AND sha256 = ?`,
  ).bind(channelId, sha256).first<MediaAssetRow>();
  return row === null ? null : toMetadata(row);
};

export const getMediaAssetForDelivery = async (
  db: D1Database,
  channelId: string,
  id: string,
  sha256: string,
): Promise<StoredMediaAsset | null> => {
  const row = await db.prepare(
    `SELECT channel_id, id, kind, mime_type, byte_size, sha256, file_name, created_at, data
       FROM media_assets
      WHERE channel_id = ? AND id = ? AND sha256 = ?`,
  ).bind(channelId, id, sha256).first<MediaAssetRow>();
  if (row === null || row.data === undefined) return null;
  return { ...toMetadata(row), channelId: row.channel_id, data: new Uint8Array(row.data) };
};

/** D1's row limit is 2 MiB; stored assets are capped at 1 MiB plus small metadata. */
export const mediaAssetResponse = (asset: StoredMediaAsset, request?: Request): Response => {
  // Bearer-token delivery is content-addressed, so a private year-long cache is safe. Cookie delivery
  // (request given) must re-check the session on every use, so it revalidates with the hash as ETag.
  const etag = `"${asset.sha256}"`;
  const headers: Record<string, string> = {
    "Content-Type": asset.mimeType,
    "X-Content-Type-Options": "nosniff",
    ...(request === undefined
      ? { "Cache-Control": "private, max-age=31536000, immutable", Vary: "Authorization" }
      : { "Cache-Control": "private, no-cache", ETag: etag }),
  };
  if (request?.headers.get("If-None-Match")?.split(",").some((value) => value.trim() === etag) === true) {
    return new Response(null, { status: 304, headers });
  }
  const body = new ArrayBuffer(asset.data.byteLength);
  new Uint8Array(body).set(asset.data);
  return new Response(body, { headers });
};
