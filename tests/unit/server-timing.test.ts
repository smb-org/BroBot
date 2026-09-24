import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { recordServerTiming, serverTimingMiddleware } from "../../src/worker/server-timing";

describe("dashboard Server-Timing", () => {
  it("adds fixed auth, D1, DO, and Helix phases without exposing request data", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("/api/*", serverTimingMiddleware);
    app.get("/api/channels", (context) => {
      recordServerTiming(context, "auth", 1.4);
      recordServerTiming(context, "d1", 2.5);
      recordServerTiming(context, "do", 3.6);
      recordServerTiming(context, "helix", 4.7);
      return context.json({ ok: true });
    });
    const response = await app.fetch(
      new Request("https://brobot.example/api/channels?access_token=private-value"),
      {},
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const timing = response.headers.get("Server-Timing");
    expect(timing).toMatch(/^auth;dur=1\.4, d1;dur=2\.5, do;dur=3\.6, helix;dur=4\.7$/u);
    expect(timing).not.toContain("private-value");
    expect(timing).not.toMatch(/token|authorization|client.secret/iu);
  });
});
