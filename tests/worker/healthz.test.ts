import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Worker-Grundgerüst", () => {
  it("beantwortet /healthz mit dem konfigurierten Status", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost/healthz"),
    );
    const body = await response.json<{
      status: string;
      missingBindings: string[];
    }>();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.missingBindings).toEqual([]);
  });
});
