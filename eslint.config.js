import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Mantine gehoert hinter die Naht `src/dashboard/ui/`. Die Bauteile dort
 * sprechen Projektvokabular, nicht Bibliotheksvokabular -- deshalb laesst sich
 * hinter der Naht ein Bauteil austauschen, ohne dass eine Aufrufstelle sich
 * aendert. Das Muster haengt an jeder bestehenden Importgrenze statt in einem
 * eigenen Block: ein spaeterer Block ueberschreibt `no-restricted-imports`
 * sonst vollstaendig, und die Grenze greift lautlos nicht mehr.
 */
const mantineBoundaryPattern = {
  group: ["@mantine/*"],
  message: "Mantine nur in src/dashboard/ui/. Panels importieren aus der Naht.",
};
const tablerBoundaryPattern = {
  group: ["@tabler/icons-react"],
  message: "Import Tabler icons only from src/dashboard/ui/Icon.tsx.",
};
const tablerBoundaryPath = {
  name: "@tabler/icons-react",
  message: "Tabler icons may only be imported from src/dashboard/ui/Icon.tsx.",
};
const richTextareaBoundaryPattern = {
  group: ["rich-textarea", "rich-textarea/*"],
  message: "Import rich-textarea only from src/dashboard/ui/.",
};
const overlayViewBoundaryPattern = {
  regex: "(^|/)overlay(/|$)",
  message: "Panel views may not import overlay modules.",
};
const overlayEditorImportBoundaryPattern = {
  regex: "(^|/)overlay/(?!canvas(?:\\.[^/]+)?$|model(?:\\.[^/]+)?$|variable\\.css(?:\\?inline)?$)",
  message: "The overlay editor may only import the shared canvas, model types and variable styles.",
};

const moduleIsolationPatterns = [
  {
    regex: "^\\.\\./(?:modules/|(?:\\.\\./)+modules/|(?!(?:(?:\\.\\./)+dashboard/(?:locale|ui)(?:\\.[^/]+)?(?:/|$)|(?:\\.\\./)+contracts|(?:\\.\\./)+text_(?:commands|library)/contracts|(?:\\.\\./)+contract|contract|contracts|domain|service|repository|adapters|overlay|panel)(?:\\.[^/]+)?(?:/|$))[^/]+(?:/|$))",
    message: "Module dürfen kein anderes Modul importieren.",
  },
  {
    regex: "^(?:src/)?modules/",
    message: "Module dürfen kein anderes Modul importieren.",
  },
  mantineBoundaryPattern,
  tablerBoundaryPattern,
  richTextareaBoundaryPattern,
];

const overlayBoundaryPatterns = [
  {
    regex: "^\\.\\./modules/[^/]+/overlay/(?!element(?:\\.[^/]+)?$)",
    message: "Module overlay views must be loaded through their registered dynamic loader.",
  },
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
  mantineBoundaryPattern,
  tablerBoundaryPattern,
  richTextareaBoundaryPattern,
];

const overlayRestrictedImportPatterns = [
  ...moduleIsolationPatterns,
  ...overlayBoundaryPatterns.filter((pattern) => pattern !== mantineBoundaryPattern && pattern !== tablerBoundaryPattern && pattern !== richTextareaBoundaryPattern),
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
  overlayViewBoundaryPattern,
  mantineBoundaryPattern,
  tablerBoundaryPattern,
  richTextareaBoundaryPattern,
];

const panelRestrictedImportPatterns = [
  ...moduleIsolationPatterns,
  ...panelBoundaryPatterns.filter((pattern) => pattern !== mantineBoundaryPattern && pattern !== tablerBoundaryPattern && pattern !== richTextareaBoundaryPattern),
];

export default defineConfig(
  globalIgnores([
    ".claude/**",
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
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    ignores: ["src/dashboard/ui/Icon.tsx"],
    rules: {
      "no-restricted-imports": ["error", { paths: [tablerBoundaryPath], patterns: [richTextareaBoundaryPattern] }],
    },
  },
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
    ignores: ["src/dashboard/ui/Icon.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: panelBoundaryPatterns },
      ],
    },
  },
  {
    // The editor shares the canvas and variable styles with the live overlay renderer.
    files: ["src/dashboard/OverlayEditorPage.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: panelBoundaryPatterns.map((pattern) => pattern === overlayViewBoundaryPattern ? overlayEditorImportBoundaryPattern : pattern) },
      ],
    },
  },
  {
    // Die Gegenrichtung: ui/ ist Darstellung und kennt weder Module noch
    // Worker. Sonst waere die Naht nach zwei Modulen keine Naht mehr.
    //
    // Dieser Block muss NACH dem Dashboard-Block stehen: ui/ liegt unter
    // src/dashboard/**, und in der Flat Config gewinnt der spaetere Block.
    // Davor haette der Dashboard-Block hier Mantine verboten -- also genau
    // an der einen Stelle, an der es erlaubt sein muss.
    files: ["src/dashboard/ui/**/*.{ts,tsx}"],
    ignores: ["src/dashboard/ui/Icon.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
            patterns: [
              {
                group: ["**/modules/**", "**/worker/**"],
                message: "ui/ ist Darstellung: keine Module, kein Worker.",
              },
              tablerBoundaryPattern,
            ],
        },
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
            tablerBoundaryPath,
          ],
          patterns: [
            richTextareaBoundaryPattern,
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
  {
    // Raw-field guard (editor-konzept 15.5): a raw <input>/<select>/<textarea>
    // belongs only behind the seam (Field, NumberField, TextArea, TagInput,
    // SegmentedControl, ChoiceCards, Switch).
    files: ["src/dashboard/**/*.tsx", "src/modules/*/panel/**/*.tsx"],
    ignores: ["src/dashboard/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name=/^(input|select|textarea)$/]",
          message: "Raw form fields only in src/dashboard/ui/ -- use Field, NumberField, TextArea, TagInput, SegmentedControl, ChoiceCards, or Switch (editor-konzept 15).",
        },
      ],
    },
  },
);
