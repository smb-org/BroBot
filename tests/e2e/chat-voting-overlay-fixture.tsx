import { createRoot } from "react-dom/client";

import Tally from "../../src/modules/chat_voting/overlay/tally";
import "../../src/overlay/variable.css";

const count = Number(new URLSearchParams(window.location.search).get("terms") ?? "0");
const terms = Array.from({ length: Math.max(0, Math.min(5, count)) }, (_, index) => ({
  term: `term-${String(index)}-extraordinarily-long`.slice(0, 25),
  count: 123_456 + index,
  approved: true,
}));

document.body.style.margin = "0";
document.documentElement.style.width = "320px";
document.body.style.width = "320px";
document.body.style.overflow = "hidden";

createRoot(document.getElementById("root") as HTMLElement).render(
  <main style={{ width: "320px", minWidth: 0, boxSizing: "border-box" }}>
    <Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "layout-poll",
      status: "open",
      preset: "free_text",
      optionCount: 0,
      labels: [],
      counts: [],
      terms,
      termFilterReady: true,
      revision: 1,
    }} language="en" now={Date.now()} />
  </main>,
);
