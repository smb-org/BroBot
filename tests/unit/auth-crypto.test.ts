import { describe, expect, it } from "vitest";

import {
  decryptJson,
  encryptJson,
  parseKeyRing,
  signJson,
  verifyJson,
} from "../../src/worker/auth/crypto";

const base64url = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const keyRing = (activeId: string, activeByte: number, retired: Array<[string, number]> = []) =>
  parseKeyRing(JSON.stringify({
    active: { id: activeId, key: base64url(activeByte) },
    retired: retired.map(([id, byte]) => ({ id, key: base64url(byte) })),
  }));

describe("WebCrypto-Schlüsselringe", () => {
  it("liest mit dem ausgemusterten Verschlüsselungsschlüssel weiter", async () => {
    const oldKeys = keyRing("v1", 1);
    const rotatedKeys = keyRing("v2", 2, [["v1", 1]]);
    const sealed = await encryptJson({ userId: "123" }, oldKeys);

    await expect(decryptJson<{ userId: string }>(sealed, rotatedKeys)).resolves.toEqual({
      userId: "123",
    });
  });

  it("liest mit dem ausgemusterten Signaturschlüssel weiter und signiert neu aktiv", async () => {
    const oldKeys = keyRing("v1", 1);
    const rotatedKeys = keyRing("v2", 2, [["v1", 1]]);
    const oldSignature = await signJson({ state: "gültig" }, oldKeys);
    const newSignature = await signJson({ state: "neu" }, rotatedKeys);

    await expect(verifyJson<{ state: string }>(oldSignature, rotatedKeys)).resolves.toEqual({
      state: "gültig",
    });
    await expect(verifyJson<{ state: string }>(newSignature, rotatedKeys)).resolves.toEqual({
      state: "neu",
    });
    await expect(verifyJson<{ state: string }>(newSignature, oldKeys)).resolves.toBeNull();
  });

  it("verwirft manipulierte Ciphertexte und Signaturen", async () => {
    const keys = keyRing("v1", 1);
    const encrypted = await encryptJson({ state: "gültig" }, keys);
    const signed = await signJson({ state: "gültig" }, keys);

    await expect(decryptJson(encrypted.slice(0, -1), keys)).resolves.toBeNull();
    await expect(verifyJson(signed.slice(0, -1), keys)).resolves.toBeNull();
  });
});
