import { describe, expect, it } from "vitest";

import { chatVotingRoutes } from "../../src/modules/chat_voting/routes";

describe("chat voting routes", () => {
  it.each([
    ["missing", { preset: "yes_no" }],
    ["negative", { preset: "yes_no", durationSeconds: -1 }],
    ["fractional", { preset: "yes_no", durationSeconds: 1.5 }],
    ["above four hours", { preset: "yes_no", durationSeconds: 14_401 }],
    ["wrong type", { preset: "yes_no", durationSeconds: "60" }],
  ])("rejects a %s per-vote duration before starting", async (_case, body) => {
    const response = await chatVotingRoutes.request("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "chat_voting_request_invalid" });
  });
});
