import { describe, expect, it } from "vitest";

import {
  createSessionCookie,
  readSessionCookie,
  serializeSessionCookie,
} from "../../src/worker/auth/session";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const keyRing = (activeId: string, activeByte: number, retired: Array<[string, number]> = []): string => JSON.stringify({
  active: { id: activeId, key: key(activeByte) },
  retired: retired.map(([id, byte]) => ({ id, key: key(byte) })),
});

const payload = {
  sessionId: "session-1",
};

describe("Session cookie", () => {
  it("rejects a tampered cookie", async () => {
    const cookie = await createSessionCookie(
      payload,
      keyRing("cookie-v1", 1),
      keyRing("encryption-v1", 2),
    );

    await expect(readSessionCookie(
      `${cookie}x`,
      keyRing("cookie-v1", 1),
      keyRing("encryption-v1", 2),
    )).resolves.toBeNull();
  });

  it("accepts retired keys when reading and uses active keys when reissuing", async () => {
    const oldCookieKeys = keyRing("cookie-v1", 1);
    const oldEncryptionKeys = keyRing("encryption-v1", 2);
    const rotatedCookieKeys = keyRing("cookie-v2", 3, [["cookie-v1", 1]]);
    const rotatedEncryptionKeys = keyRing("encryption-v2", 4, [["encryption-v1", 2]]);
    const oldCookie = await createSessionCookie(payload, oldCookieKeys, oldEncryptionKeys);
    const newCookie = await createSessionCookie(payload, rotatedCookieKeys, rotatedEncryptionKeys);

    await expect(readSessionCookie(oldCookie, rotatedCookieKeys, rotatedEncryptionKeys))
      .resolves.toEqual(payload);
    await expect(readSessionCookie(newCookie, rotatedCookieKeys, rotatedEncryptionKeys))
      .resolves.toEqual(payload);
    expect(newCookie).not.toBe(oldCookie);
  });

  it("serializes HttpOnly, Secure, and SameSite=Lax attributes", () => {
    const serialized = serializeSessionCookie("signed-value", 604800);

    expect(serialized).toBe(
      "__Host-brobot_session=signed-value; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });
});
