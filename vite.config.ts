import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare({ inspectorPort: false })],
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
          output: {
            manualChunks: (id) =>
              id.includes("node_modules/react") ? "react" : undefined,
          },
        },
      },
    },
  },
});
