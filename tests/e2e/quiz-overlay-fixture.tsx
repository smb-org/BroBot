import { useState } from "react";
import { createRoot } from "react-dom/client";

import { OverlayCanvas } from "../../src/overlay/canvas";
import type { OverlayElementData } from "../../src/overlay/model";

const now = Date.now();
const question = "Which city sits on the Spree?";
const options = ["Berlin", "Bonn", "Bremen", "Dresden"];
const phaseState = (phase: "announce" | "open" | "paused" | "reveal" | "results") => ({
  sessionId: "quiz-e2e-fixture",
  phaseSequence: 1,
  sessionStartedAt: new Date(now).toISOString(),
  phase: phase === "paused" ? "open" : phase,
  questionIndex: 0,
  questionCount: 3,
  question,
  options,
  phaseEndsAt: phase === "paused" ? null : new Date(now + 30_000).toISOString(),
  paused: phase === "paused",
  remainingMs: phase === "paused" ? 12_000 : null,
  serverNow: new Date(now).toISOString(),
  ...(phase === "reveal" ? { correctIndex: 0, answerDistribution: [12, 5, 3, 1] } : {}),
  ...(phase === "results" ? {
    ranking: Array.from({ length: 10 }, (_, index) => ({ login: `viewer${String(index + 1)}`, correct: 10 - index, rank: index + 1 })),
  } : {}),
});

export const QuizOverlayFixture = () => {
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  const element: OverlayElementData = {
    id: "quiz-fixture",
    kind: "quiz.session",
    label: "Quiz",
    variableName: null,
    text: "",
    config: {},
    state,
    moduleEnabled: true,
    x: 0,
    y: 0,
    scalePercent: 100,
    z: 0,
    inComposition: true,
  };
  const overlay = { id: "quiz-fixture", revision: 1, width: 1920, height: 1080, css: "", elements: [element] };

  return <>
    <nav aria-label="Mock quiz phases">
      {(["announce", "open", "paused", "reveal", "results"] as const).map((phase) => <button key={phase} onClick={() => setState(phaseState(phase))}>
        {phase}
      </button>)}
      <button onClick={() => setState(null)}>idle</button>
    </nav>
    <OverlayCanvas overlay={overlay} language="en" variables={{}} elementId={null} />
  </>;
};

document.body.style.margin = "0";
createRoot(document.getElementById("root") as HTMLElement).render(<QuizOverlayFixture />);
