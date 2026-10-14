import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { assertOverlayBundleHasNoTanstack } from "./scripts/overlay-bundle-check";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    react({ compiler: { sources: ["/src/dashboard/"] } }),
    cloudflare({ inspectorPort: false }),
  ],
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
  build: {
    assetsDir: "_app",
    manifest: true,
    sourcemap: true,
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            dashboard: resolve(import.meta.dirname, "index.html"),
            overlay: resolve(import.meta.dirname, "overlay.html"),
          },
          plugins: [{
            name: "brobot-overlay-tanstack-boundary",
            generateBundle(_options, bundle) {
              assertOverlayBundleHasNoTanstack(bundle);
            },
          }],
          output: {
            manualChunks: (id) =>
              id.includes("node_modules/react") ? "react" : undefined,
          },
        },
      },
    },
  },
});
