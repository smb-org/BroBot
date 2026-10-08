import { describe, expect, it } from "vitest";

import { assertOverlayBundleHasNoTanstack } from "../../scripts/overlay-bundle-check";

describe("overlay bundle dependency boundary", () => {
  it("checks static and dynamic chunks reachable from overlay.html", () => {
    const bundle = {
      "overlay.html": {
        type: "asset" as const,
        fileName: "overlay.html",
        source: '<script type="module" src="/_app/overlay.js"></script>',
      },
      "_app/overlay.js": {
        type: "chunk" as const,
        fileName: "_app/overlay.js",
        imports: ["_app/shared.js"],
        dynamicImports: ["_app/overlay-module.js"],
        modules: { "/src/overlay/main.tsx": {} },
        code: "",
      },
      "_app/shared.js": {
        type: "chunk" as const,
        fileName: "_app/shared.js",
        imports: [],
        dynamicImports: [],
        modules: { "/src/overlay/canvas.tsx": {} },
        code: "",
      },
      "_app/overlay-module.js": {
        type: "chunk" as const,
        fileName: "_app/overlay-module.js",
        imports: [],
        dynamicImports: [],
        modules: { "/node_modules/.pnpm/@tanstack+react-query@5/node_modules/@tanstack/react-query/build/index.js": {} },
        code: "",
      },
      "_app/dashboard.js": {
        type: "chunk" as const,
        fileName: "_app/dashboard.js",
        imports: [],
        dynamicImports: [],
        modules: { "/node_modules/@tanstack/react-query/build/index.js": {} },
        code: "",
      },
    };

    expect(() => { assertOverlayBundleHasNoTanstack(bundle); }).toThrow(/@tanstack/);
  });

  it("allows query dependencies in dashboard chunks unreachable from the overlay", () => {
    const bundle = {
      "overlay.html": {
        type: "asset" as const,
        fileName: "overlay.html",
        source: '<script type="module" src="/_app/overlay.js"></script>',
      },
      "_app/overlay.js": {
        type: "chunk" as const,
        fileName: "_app/overlay.js",
        imports: [],
        dynamicImports: [],
        modules: { "/src/overlay/main.tsx": {} },
        code: "",
      },
      "_app/dashboard.js": {
        type: "chunk" as const,
        fileName: "_app/dashboard.js",
        imports: [],
        dynamicImports: [],
        modules: { "/node_modules/@tanstack/react-query/build/index.js": {} },
        code: "",
      },
    };

    expect(() => { assertOverlayBundleHasNoTanstack(bundle); }).not.toThrow();
  });
});
