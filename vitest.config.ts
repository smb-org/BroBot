import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // Tests laufen in UTC, damit ein formatierter Zeitpunkt überall dasselbe
    // ergibt. Ohne das ist ein Test in Mitteleuropa grün und in der CI rot.
    // Steht hier und nicht nur im npm-Skript, damit es auch gilt, wenn jemand
    // Vitest direkt aus der Entwicklungsumgebung startet.
    env: { TZ: "UTC" },
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/components/**/*.test.tsx"],
  },
});
