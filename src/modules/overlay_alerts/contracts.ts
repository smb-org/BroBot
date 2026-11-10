import type { MediaKind, MediaMimeType } from "./domain/media";

export interface MediaAssetMetadata {
  id: string;
  kind: MediaKind;
  mimeType: MediaMimeType;
  byteSize: number;
  sha256: string;
  fileName: string;
  createdAt: string;
}

