import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const moduleIsolationPatterns = [
  {
    regex: "^\\.\\./(?:modules/|(?:\\.\\./)+modules/|(?!(?:contract|contracts|domain|service|repository|adapters|overlay|panel)(?:\\.[^/]+)?(?:/|$))[^/]+(?:/|$))",
    message: "Module dürfen kein anderes Modul importieren.",
  },
  {
    regex: "^(?:src/)?modules/",
    message: "Module dürfen kein anderes Modul importieren.",
  },
];

const overlayBoundaryPatterns = [
  {
    regex: "(^|/)worker(/|$)",
    message: "Overlay-Ansichten dürfen nichts aus src/worker importieren.",
  },
  {
    regex: "(^|/)(service|repository|adapters)(?:\\.[^/]+)?(?:/|$)",
    message: "Overlay-Ansichten dürfen keine Service-, Repository- oder Adapterdateien importieren.",
  },
  {
    regex: "^zod$",
    message: "Overlay-Ansichten dürfen Zod nicht importieren.",
  },
];

const overlayRestrictedImportPatterns = [
  ...moduleIsolationPatterns,
  ...overlayBoundaryPatterns,
];

const panelBoundaryPatterns = [
  {
    regex: "(^|/)worker(/|$)",
    message: "Panel-Ansichten dürfen nichts aus src/worker importieren.",
  },
  {
    regex: "(^|/)(repository|adapters)(?:\\.[^/]+)?(?:/|$)",
    message: "Panel-Ansichten dürfen keine Repository- oder Adapterdateien importieren.",
  },
  {
    regex: "(^|/)overlay(/|$)",
    message: "Panel-Ansichten dürfen keine Overlay-Ansichten importieren.",
  },
];

const panelRestrictedImportPatterns = [
  ...moduleIsolationPatterns,
  ...panelBoundaryPatterns,
];

export default defineConfig(
  globalIgnores([
    ".wrangler/**",
    "dist/**",
    "coverage/**",
    "node_modules/**",
    "playwright-report/**",
    "test-results/**",
    "worker-configuration.d.ts",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  reactHooks.configs.flat.recommended,
  reactRefresh.configs.vite,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  },
  {
    // Ein Modul bleibt ein isolierter Feature-Slice: Der Regex blockiert
    // relative Imports zu Geschwister-Modulen und explizite Rücksprünge nach
    // src/modules. Gemeinsame Verträge gehören in src/modules/contract.ts.
    files: ["src/modules/*/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: moduleIsolationPatterns },
      ],
    },
  },
  {
    // Das Overlay bleibt eine minimale Darstellung: Es darf keine Worker-,
    // Persistenz- oder Serviceschicht und kein Zod in sein Bundle ziehen.
    files: ["src/overlay/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: overlayBoundaryPatterns },
      ],
    },
  },
  {
    files: ["src/modules/*/overlay/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: overlayRestrictedImportPatterns },
      ],
    },
  },
  {
    // Das Panel ist die primäre Bedienoberfläche: Es darf für Formulare Zod
    // und für auszulösende Anwendungsfälle den Service verwenden. Repository-
    // und Adapterzugriff bleiben trotzdem hinter dem Service verborgen.
    files: ["src/dashboard/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: panelBoundaryPatterns },
      ],
    },
  },
  {
    files: ["src/modules/*/panel/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: panelRestrictedImportPatterns },
      ],
    },
  },
  {
    // Worker-Code bleibt frei von React, damit die Runtime keinen UI-Code lädt.
    files: ["src/worker/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "Der Worker darf React nicht importieren." },
            { name: "react-dom", message: "Der Worker darf react-dom nicht importieren." },
          ],
          patterns: [
            {
              regex: "^react(?:/|$)",
              message: "Der Worker darf React nicht importieren.",
            },
            {
              regex: "^react-dom(?:/|$)",
              message: "Der Worker darf react-dom nicht importieren.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["vite.config.ts", "vitest.config.ts", "vitest.worker.config.ts", "playwright.config.ts", "scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    files: ["**/*.tsx"],
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
);
