import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";

// The host owns two paths directly under /api/channels/:channelId/modules/:moduleId
// (module-routes.ts): the bare module path (PATCH enables/disables it) and
// "settings" (the generic GET/PATCH module-settings shape). Hono resolves a
// handler by registration order, and the host's generic routes are added
// before any module's own router is mounted, so a module registering either
// path is silently shadowed rather than rejected — this is exactly how the
// sun module's own "/settings" route collided and crashed the panel.
//
// A module route also collides if its first segment is a parameter (":x") or
// a wildcard ("*"): those patterns match "" and "settings" too, so they would
// shadow (or be shadowed by) the host's routes just the same. We don't care
// which method collides — the host owns GET+PATCH on /settings and PATCH on
// root, so treating any method as colliding is simpler and just as correct.
const collidesWithHostReservedPath = (path: string): boolean => {
  const firstSegment = path.split("/").find((segment) => segment.length > 0) ?? "";
  return firstSegment === "" || firstSegment === "settings" || firstSegment.startsWith(":") || firstSegment.startsWith("*");
};

describe("module route registration", () => {
  it("collision predicate flags reserved patterns and accepts a real module path", () => {
    expect(collidesWithHostReservedPath("/settings")).toBe(true);
    expect(collidesWithHostReservedPath("/:x")).toBe(true);
    expect(collidesWithHostReservedPath("/*")).toBe(true);
    expect(collidesWithHostReservedPath("/")).toBe(true);
    expect(collidesWithHostReservedPath("/location")).toBe(false);
  });

  it("never registers a route the host already owns under /modules/:moduleId/*", () => {
    for (const module of MODULES) {
      if (module.routes === undefined) continue;
      for (const route of module.routes.routes) {
        expect(
          collidesWithHostReservedPath(route.path),
          `${module.id} registers ${route.method} ${route.path}, which the host already owns under /modules/:moduleId/*`,
        ).toBe(false);
      }
    }
  });
});
