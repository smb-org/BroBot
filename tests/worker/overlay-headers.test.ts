import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const overlayCspFor = (publicOrigin: string): string => {
  const url = new URL(publicOrigin);
  const websocketScheme = url.protocol === "https:" ? "wss:" : "ws:";
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `script-src ${url.origin}`,
    `style-src ${url.origin} 'unsafe-inline'`,
    `img-src ${url.origin}`,
    `font-src ${url.origin}`,
    `connect-src ${url.origin} ${websocketScheme}//${url.host}`,
  ].join("; ");
};

describe("overlay document security headers", () => {
  const publicOrigin = (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN;

  it.each(["/overlay", "/overlay.html"])("sets the public-origin CSP on %s without blocking embedding", async (path) => {
    const response = await exports.default.fetch(new Request(`http://localhost${path}`));

    expect(response.headers.get("content-security-policy")).toBe(overlayCspFor(publicOrigin));
    expect(response.headers.get("content-security-policy")).not.toContain("frame-ancestors");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("leaves dashboard assets and API responses unchanged", async () => {
    const dashboard = await exports.default.fetch(new Request("http://localhost/"));
    const api = await exports.default.fetch(new Request("http://localhost/api/overlay/bootstrap"));

    expect(dashboard.headers.get("content-security-policy")).toBeNull();
    expect(dashboard.headers.get("x-frame-options")).toBeNull();
    expect(api.status).toBe(401);
    expect(api.headers.get("content-security-policy")).toBeNull();
    expect(api.headers.get("x-frame-options")).toBeNull();
  });
});
