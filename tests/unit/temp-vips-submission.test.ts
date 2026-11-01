import { describe, expect, it, vi } from "vitest";

import { createTempVipSubmissionTracker } from "../../src/modules/temp_vips/panel/submission";
import { grantTempVip } from "../../src/modules/temp_vips/panel/service";

describe("temporary VIP submission retries", () => {
  it("reuses the operation ID after a lost response and changes it when the payload changes", async () => {
    const ids = ["operation-first", "operation-changed"];
    const tracker = createTempVipSubmissionTracker(() => ids.shift() ?? "unexpected-operation");
    const sent: Array<{ operationId: string; payload: { login: string; durationMs: number } }> = [];

    await expect(tracker.submit("grant", { login: "pixelpilz", durationMs: 600_000 }, (operationId) => {
      sent.push({ operationId, payload: { login: "pixelpilz", durationMs: 600_000 } });
      return Promise.reject(new TypeError("response lost after commit"));
    })).rejects.toThrow("response lost after commit");

    await expect(tracker.submit("grant", { login: "pixelpilz", durationMs: 600_000 }, (operationId) => {
      sent.push({ operationId, payload: { login: "pixelpilz", durationMs: 600_000 } });
      return Promise.reject(new TypeError("retry response timed out"));
    })).rejects.toThrow("retry response timed out");
    await tracker.submit("grant", { login: "pixelpilz", durationMs: 1_200_000 }, (operationId) => {
      sent.push({ operationId, payload: { login: "pixelpilz", durationMs: 1_200_000 } });
      return Promise.resolve({ status: "granted" });
    });

    expect(sent.map(({ operationId }) => operationId)).toEqual([
      "operation-first", "operation-first", "operation-changed",
    ]);
  });

  it("keeps the operation ID and grant payload through the panel service after a committed request loses its response", async () => {
    const posted: Array<{ operationId: string; login: string; durationMs: number }> = [];
    const committed = new Set<string>();
    let appliedDurationMs = 0;
    let loseFirstResponse = true;
    const fetchMock = vi.fn((input: string, init?: { body?: string }): Promise<Response> => {
      if (input === "/api/csrf") return Promise.resolve(new Response(JSON.stringify({ token: "csrf_demo" })));
      const request = JSON.parse(init?.body ?? "{}") as { operationId: string; login: string; durationMs: number };
      posted.push(request);
      if (!committed.has(request.operationId)) {
        committed.add(request.operationId);
        appliedDurationMs += request.durationMs;
      }
      if (loseFirstResponse) {
        loseFirstResponse = false;
        return Promise.reject(new TypeError("response lost after server commit"));
      }
      return Promise.resolve(new Response(JSON.stringify({ status: "granted" })));
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(grantTempVip("channel_retry_demo", "pixelpilz", 600_000)).rejects.toThrow("response lost after server commit");
      await expect(grantTempVip("channel_retry_demo", "pixelpilz", 600_000)).resolves.toMatchObject({ status: "granted" });
      await expect(grantTempVip("channel_retry_demo", "pixelpilz", 1_200_000)).resolves.toMatchObject({ status: "granted" });

      expect(posted[0]?.operationId).toBe(posted[1]?.operationId);
      expect(posted[0]).toEqual(posted[1]);
      expect(posted[2]?.operationId).not.toBe(posted[1]?.operationId);
      expect(appliedDurationMs).toBe(1_800_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
