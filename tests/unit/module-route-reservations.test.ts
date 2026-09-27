import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";

// The host owns two paths directly under /api/channels/:channelId/modules/:moduleId
// (module-routes.ts): the bare module path (PATCH enables/disables it) and
// "settings" (the generic GET/PATCH module-settings shape). Hono resolves a
// handler by registration order, and the host's generic routes are added
// before any module's own router is mounted, so a module registering either
// path is silently shadowed rather than rejected — this is exactly how the
// sun module's own "/settings" route collided and crashed the panel.
const HOST_RESERVED_SUBPATHS = new Set(["", "settings"]);

describe("module route registration", () => {
  it("never registers a route the host already owns under /modules/:moduleId/*", () => {
    for (const module of MODULES) {
      if (module.routes === undefined) continue;
      for (const route of module.routes.routes) {
        const firstSegment = route.path.split("/").find((segment) => segment.length > 0) ?? "";
        expect(
          HOST_RESERVED_SUBPATHS.has(firstSegment),
          `${module.id} registers ${route.method} ${route.path}, which the host already owns under /modules/:moduleId/*`,
        ).toBe(false);
      }
    }
  });
});
