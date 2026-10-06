import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "../../../src/overlay/variable.css";
import BelaboxStatus from "../../../src/modules/belabox/overlay/status";

const root = document.getElementById("root");
if (root === null) throw new Error("BELABOX status test root is missing.");

const query = new URLSearchParams(window.location.search);
const layout = query.get("layout") === "detail" ? "detail" : "compact";
const state = query.get("state");
const now = Date.now();
const sample = state === "no-data" ? null : {
  at: new Date(now - (state === "stale" ? 45_001 : 0)).toISOString(),
  connected: true,
  bitrateKbps: 4_520,
  rttMs: 38,
  phase: "healthy",
};

createRoot(root).render(createElement(BelaboxStatus, {
  config: { layout, unit: "kbps", hideWhenHealthy: false },
  state: { sample, intervalSeconds: 15 },
  now,
  language: "en",
}));
