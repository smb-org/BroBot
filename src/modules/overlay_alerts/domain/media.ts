export const MEDIA_MAXIMUM_BYTES = 1_048_576;
export const MEDIA_MAXIMUM_ASSETS_PER_CHANNEL = 200;

const ALLOWED_MEDIA_TYPES = {
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "audio/mpeg": "sound",
  "audio/ogg": "sound",
  "audio/wav": "sound",
} as const;

export type MediaMimeType = keyof typeof ALLOWED_MEDIA_TYPES;
export type MediaKind = (typeof ALLOWED_MEDIA_TYPES)[MediaMimeType];

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((byte, index) => bytes[index] === byte);

const asciiAt = (bytes: Uint8Array, offset: number, value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
};

const hasMediaSignature = (bytes: Uint8Array, mimeType: MediaMimeType): boolean => {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif":
      return asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a");
    case "image/webp":
      return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP");
    case "audio/mpeg":
      return asciiAt(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
    case "audio/ogg":
      return asciiAt(bytes, 0, "OggS");
    case "audio/wav":
      return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE");
  }
};

/** Browser and OS labels for the same audio formats; stored and served as the canonical type. */
const MEDIA_MIME_ALIASES: Readonly<Record<string, MediaMimeType>> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/mp3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-ogg": "audio/ogg",
};

/** Validates that the declared MIME type is allowed and matches the file signature. */
export const detectMediaType = (bytes: Uint8Array, declaredMimeType: string): { mimeType: MediaMimeType; kind: MediaKind } | null => {
  const declared = declaredMimeType.split(";", 1)[0]?.trim().toLowerCase();
  const mimeType = declared !== undefined && Object.hasOwn(MEDIA_MIME_ALIASES, declared)
    ? MEDIA_MIME_ALIASES[declared]
    : declared;
  if (mimeType === undefined || !Object.hasOwn(ALLOWED_MEDIA_TYPES, mimeType)) return null;
  const allowedMimeType = mimeType as MediaMimeType;
  return hasMediaSignature(bytes, allowedMimeType)
    ? { mimeType: allowedMimeType, kind: ALLOWED_MEDIA_TYPES[allowedMimeType] }
    : null;
};

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const safeMediaFileName = (name: string): string => {
  const leafName = name.split(/[\\/]/u).at(-1) ?? "";
  let withoutControls = "";
  for (let index = 0; index < leafName.length; index += 1) {
    const character = leafName[index];
    const code = leafName.charCodeAt(index);
    if (character !== undefined && code >= 0x20 && code !== 0x7f) withoutControls += character;
  }
  const cleaned = withoutControls.trim().slice(0, 255);
  return cleaned.length > 0 ? cleaned : "media";
};
