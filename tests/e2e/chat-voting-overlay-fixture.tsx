import { createRoot } from "react-dom/client";

import { OverlayCanvas } from "../../src/overlay/canvas";
import "../../src/overlay/variable.css";

const parameters = new URLSearchParams(window.location.search);
const count = Number(parameters.get("terms") ?? "0");
const mobile = parameters.get("mobile") === "1";
const narrow = parameters.get("narrow") === "1";
const standard = parameters.get("preset") === "standard";
const width = narrow ? 200 : mobile ? 390 : 1920;
const title = parameters.has("title") ? parameters.get("title") || null : null;
const countdownMode = parameters.get("countdown") ?? "none";
const localNow = Date.now();
const terms = Array.from({ length: Math.max(0, Math.min(5, count)) }, (_, index) => ({
  term: `term-${String(index)}-extraordinarily-long`.slice(0, 25),
  count: 123_456 + index,
  approved: true,
}));

document.body.style.margin = "0";

const overlay = {
  id: "overlay-fixture",
  revision: 1,
  width,
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
      width: narrow ? 200 : mobile ? 360 : 480,
    },
    state: {
      pollId: "layout-poll",
      status: countdownMode === "closed" ? "closed" : "open",
      openedAt: new Date(localNow).toISOString(),
      closesAt: new Date(localNow + 90_000).toISOString(),
      requestedDurationSeconds: countdownMode === "open-ended" || countdownMode === "none" ? null : 90,
      ...(countdownMode === "closed" ? { closedAt: new Date(localNow).toISOString() } : {}),
      title,
      preset: standard ? "yes_no" : "free_text",
      optionCount: standard ? 2 : 0,
      labels: standard ? [
        "A deliberately long affirmative choice that wraps at narrow widths",
        "A deliberately long negative choice that wraps at narrow widths",
      ] : [],
      counts: standard ? [1, 2] : [],
      terms,
      termFilterReady: true,
      revision: 1,
    },
  }],
};

createRoot(document.getElementById("root") as HTMLElement).render(
  <OverlayCanvas overlay={overlay} language="en" variables={{}} elementId={null} />,
);
