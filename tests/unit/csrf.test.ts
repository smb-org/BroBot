import { describe, expect, it } from "vitest";

import {
  createCsrfToken,
  serializeCsrfCookie,
  verifyCsrfToken,
} from "../../src/worker/auth/csrf";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const keyRing = JSON.stringify({
  active: { id: "csrf-v1", key: key(1) },
  retired: [],
});

describe("CSRF token", () => {
  it("accepts a valid token only for its own session", async () => {
    const token = await createCsrfToken("session-1", keyRing, "2026-09-18T00:00:00.000Z");

    await expect(verifyCsrfToken(token, "session-1", keyRing, "2026-09-18T00:01:00.000Z"))
      .resolves.toBe(true);
    await expect(verifyCsrfToken(token, "session-2", keyRing, "2026-09-18T00:01:00.000Z"))
      .resolves.toBe(false);
  });

  it("rejects an expired or tampered token", async () => {
    const token = await createCsrfToken("session-1", keyRing, "2026-09-18T00:00:00.000Z");

    await expect(verifyCsrfToken(token, "session-1", keyRing, "2026-09-25T00:00:01.000Z"))
      .resolves.toBe(false);
    await expect(verifyCsrfToken(`${token}x`, "session-1", keyRing, "2026-09-18T00:01:00.000Z"))
      .resolves.toBe(false);
  });

  it("issues a non-HttpOnly cookie for the double-submit scheme", () => {
    expect(serializeCsrfCookie("token")).toBe(
      "__Host-brobot_csrf=token; Max-Age=604800; Path=/; Secure; SameSite=Lax",
    );
  });
});
