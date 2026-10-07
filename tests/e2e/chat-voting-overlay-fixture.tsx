import { createRoot } from "react-dom/client";

import { OverlayCanvas } from "../../src/overlay/canvas";
import "../../src/overlay/variable.css";

const parameters = new URLSearchParams(window.location.search);
const count = Number(parameters.get("terms") ?? "0");
const mobile = parameters.get("mobile") === "1";
const title = parameters.has("title") ? parameters.get("title") || null : null;
const countdownMode = parameters.get("countdown") ?? "none";
const serverNow = Date.now();
const terms = Array.from({ length: Math.max(0, Math.min(5, count)) }, (_, index) => ({
  term: `term-${String(index)}-extraordinarily-long`.slice(0, 25),
  count: 123_456 + index,
  approved: true,
}));

document.body.style.margin = "0";

const overlay = {
  id: "overlay-fixture",
  revision: 1,
  width: mobile ? 390 : 1920,
  height: mobile ? 844 : 1080,
  css: "",
  elements: [{
    id: "tally-a", kind: "chat_voting.tally", label: "Tally", variableName: null, text: "",
    x: 0, y: 0, scalePercent: 100, z: 0, inComposition: true, moduleEnabled: true,
    config: {
      layout: parameters.get("layout") ?? "bars",
      showPercent: true,
      showCountdown: countdownMode !== "off",
      hideAfterCloseSeconds: 15,
      width: mobile ? 360 : 480,
    },
    state: {
      pollId: "layout-poll",
      status: countdownMode === "closed" ? "closed" : "open",
      openedAt: new Date(serverNow).toISOString(),
      closesAt: new Date(serverNow + 90_000).toISOString(),
      requestedDurationSeconds: countdownMode === "open-ended" || countdownMode === "none" ? null : 90,
      serverNow: new Date(serverNow).toISOString(),
      serverTimeOffsetMs: 0,
      serverTimeLocalNowMs: serverNow,
      ...(countdownMode === "closed" ? { closedAt: new Date(serverNow).toISOString() } : {}),
      title,
      preset: "free_text",
      optionCount: 0,
      labels: [],
      counts: [],
      terms,
      termFilterReady: true,
      revision: 1,
    },
  }],
};

createRoot(document.getElementById("root") as HTMLElement).render(
  <OverlayCanvas overlay={overlay} language="en" variables={{}} elementId={null} />,
);
