export interface KeyEntry {
  id: string;
  key: string;
}

export interface KeyRing {
  active: KeyEntry;
  retired: KeyEntry[];
}

interface EncryptionEnvelope {
  keyId: string;
  iv: string;
  ciphertext: string;
}

interface SignatureEnvelope {
  keyId: string;
  payload: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeBase64url = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const encodeBase64url = (value: ArrayBuffer | Uint8Array): string => {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const encodeJson = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("JSON-Wert konnte nicht serialisiert werden.");
  return encodeBase64url(encoder.encode(serialized));
};

const decodeJson = (value: string): unknown => {
  try {
    return JSON.parse(decoder.decode(decodeBase64url(value))) as unknown;
  } catch {
    return null;
  }
};

const validateKeyEntry = (value: unknown): KeyEntry => {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 ||
      typeof value.key !== "string" || decodeBase64url(value.key).byteLength !== 32) {
    throw new Error("Schlüsselring enthält einen ungültigen Schlüssel.");
  }
  return { id: value.id, key: value.key };
};

export const parseKeyRing = (serialized: string): KeyRing => {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Schlüsselring ist kein gültiges JSON.");
  }
  if (!isRecord(value)) throw new Error("Schlüsselring muss ein Objekt sein.");
  const active = validateKeyEntry(value.active);
  const retired = Array.isArray(value.retired) ? value.retired.map(validateKeyEntry) : [];
  const ids = new Set([active.id, ...retired.map((entry) => entry.id)]);
  if (ids.size !== retired.length + 1) throw new Error("Schlüssel-IDs müssen eindeutig sein.");
  return { active, retired };
};

const keysForReading = (keys: KeyRing): KeyEntry[] => [keys.active, ...keys.retired];

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;

const importAesKey = async (entry: KeyEntry): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", toArrayBuffer(decodeBase64url(entry.key)), "AES-GCM", false, ["encrypt", "decrypt"]);

const importHmacKey = async (entry: KeyEntry): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", toArrayBuffer(decodeBase64url(entry.key)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export const encryptJson = async (value: unknown, keys: KeyRing): Promise<string> => {
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    await importAesKey(keys.active),
    toArrayBuffer(encoder.encode(JSON.stringify(value))),
  );
  const envelope: EncryptionEnvelope = {
    keyId: keys.active.id,
    iv: encodeBase64url(iv),
    ciphertext: encodeBase64url(ciphertext),
  };
  return encodeJson(envelope);
};

export const decryptJson = async <T>(serialized: string, keys: KeyRing): Promise<T | null> => {
  const envelope = decodeJson(serialized) as EncryptionEnvelope | null;
  if (envelope === null || typeof envelope.keyId !== "string" || typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string") return null;
  const entry = keysForReading(keys).find((candidate) => candidate.id === envelope.keyId);
  if (entry === undefined) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(decodeBase64url(envelope.iv)) },
      await importAesKey(entry),
      toArrayBuffer(decodeBase64url(envelope.ciphertext)),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return null;
  }
};

export const signJson = async (value: unknown, keys: KeyRing): Promise<string> => {
  const envelope: SignatureEnvelope = { keyId: keys.active.id, payload: encodeJson(value) };
  const payload = encodeJson(envelope);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(keys.active),
    toArrayBuffer(encoder.encode(payload)),
  );
  return `${payload}.${encodeBase64url(signature)}`;
};

export const verifyJson = async <T>(serialized: string, keys: KeyRing): Promise<T | null> => {
  const separator = serialized.lastIndexOf(".");
  if (separator <= 0 || separator === serialized.length - 1) return null;
  const payload = serialized.slice(0, separator);
  const signature = serialized.slice(separator + 1);
  const envelope = decodeJson(payload) as SignatureEnvelope | null;
  if (envelope === null || typeof envelope.keyId !== "string" || typeof envelope.payload !== "string") return null;
  const entry = keysForReading(keys).find((candidate) => candidate.id === envelope.keyId);
  if (entry === undefined) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importHmacKey(entry),
      toArrayBuffer(decodeBase64url(signature)),
      toArrayBuffer(encoder.encode(payload)),
    );
    return valid ? decodeJson(envelope.payload) as T : null;
  } catch {
    return null;
  }
};
