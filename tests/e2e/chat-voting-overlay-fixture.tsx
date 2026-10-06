import { createRoot } from "react-dom/client";

import { OverlayCanvas } from "../../src/overlay/canvas";
import "../../src/overlay/variable.css";

const count = Number(new URLSearchParams(window.location.search).get("terms") ?? "0");
const terms = Array.from({ length: Math.max(0, Math.min(5, count)) }, (_, index) => ({
  term: `term-${String(index)}-extraordinarily-long`.slice(0, 25),
  count: 123_456 + index,
  approved: true,
}));

document.body.style.margin = "0";

const overlay = {
  id: "overlay-fixture",
  revision: 1,
  width: 1920,
  height: 1080,
  css: "",
  elements: [{
    id: "tally-a", kind: "chat_voting.tally", label: "Tally", variableName: null, text: "",
    x: 0, y: 0, scalePercent: 100, z: 0, inComposition: true, moduleEnabled: true,
    config: { layout: new URLSearchParams(window.location.search).get("layout") ?? "bars", showPercent: true, hideAfterCloseSeconds: 15, width: 480 },
    state: {
      pollId: "layout-poll",
      status: "open",
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
