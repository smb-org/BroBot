import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import QuizOverlay from "../../src/modules/quiz/overlay/view";

const serverNow = Date.parse("2030-01-01T00:00:00.000Z");

const state = (phase: "announce" | "open" | "reveal" | "results", overrides: Record<string, unknown> = {}) => ({
  sessionId: "quiz-component-test",
  phaseSequence: 1,
  sessionStartedAt: new Date(serverNow).toISOString(),
  phase,
  questionIndex: 0,
  questionCount: 3,
  setName: "General knowledge",
  question: "Which city sits on the Spree?",
  options: ["Berlin", "Bonn", "Bremen"],
  phaseEndsAt: new Date(serverNow + 20_000).toISOString(),
  paused: false,
  remainingMs: null,
  serverNow: new Date(serverNow).toISOString(),
  ...overrides,
});

describe("quiz session overlay", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the question and numbered options while announcing", () => {
    const { container } = render(<QuizOverlay config={{}} state={state("announce")} now={serverNow} language="en" />);

    expect(screen.getByText("Which city sits on the Spree?")).not.toBeNull();
    expect(container.querySelectorAll(".quiz-session-overlay__option-number")).toHaveLength(3);
    expect(screen.queryByText("Correct")).toBeNull();
    expect(container.querySelector(".quiz-session-overlay")?.getAttribute("data-phase")).toBe("announce");
  });

  it("renders set-valid Unicode question and option lengths", () => {
    const question = `${"a".repeat(199)}😀`;
    const option = `${"b".repeat(79)}😀`;
    render(<QuizOverlay config={{}} state={state("open", {
      question,
      options: [option, "Other"],
    })} now={serverNow} language="en" />);

    expect(screen.getByText(question)).not.toBeNull();
    expect(screen.getByText(option)).not.toBeNull();
  });

  it("counts down locally from the phase end time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(serverNow);
    const { container } = render(<QuizOverlay config={{}} state={state("open")} now={serverNow} language="en" />);
    expect(screen.getByText("0:20 remaining")).not.toBeNull();
    expect(container.querySelector(".quiz-session-overlay__phase-status")?.getAttribute("aria-live")).toBe("off");

    await vi.advanceTimersByTimeAsync(2_000);

    expect(screen.getByText("0:18 remaining")).not.toBeNull();
  });

  it("keeps paused time frozen and labels the pause", async () => {
    vi.useFakeTimers();
    const paused = state("open", { paused: true, phaseEndsAt: null, remainingMs: 14_000 });
    const { container } = render(<QuizOverlay config={{}} state={paused} now={serverNow} language="en" />);

    expect(screen.getByText("Paused · 0:14")).not.toBeNull();
    expect(container.querySelector(".quiz-session-overlay__phase-status")?.getAttribute("aria-live")).toBe("polite");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(screen.getByText("Paused · 0:14")).not.toBeNull();
  });

  it("shows reveal distributions and highlights the correct numbered option", () => {
    const { container } = render(<QuizOverlay config={{}} state={state("reveal", {
      correctIndex: 1,
      answerDistribution: [2, 6, 2],
    })} now={serverNow} language="en" />);

    expect(screen.getByText("Correct")).not.toBeNull();
    expect(screen.getByText("60%")).not.toBeNull();
    expect(container.querySelector('[data-correct="true"]')?.textContent).toContain("Bonn");
    expect(container.querySelectorAll(".quiz-session-overlay__option-bar > span")).toHaveLength(3);
  });

  it("shows the top ten session rankings with correct counts and bars", () => {
    const ranking = Array.from({ length: 12 }, (_, index) => ({
      login: `viewer${String(index + 1)}`,
      correct: 12 - index,
      rank: index + 1,
    }));
    const { container } = render(<QuizOverlay config={{}} state={state("results", { ranking })} now={serverNow} language="en" />);

    expect(container.querySelector(".quiz-session-overlay__question")?.textContent).toBe("Quiz results");
    expect(container.querySelector(".quiz-session-overlay__progress")?.textContent).toBe("General knowledge");
    expect(screen.getByText("viewer1")).not.toBeNull();
    expect(screen.getByText("12 correct")).not.toBeNull();
    expect(screen.queryByText("viewer11")).toBeNull();
    expect(container.querySelectorAll(".quiz-session-overlay__rank")).toHaveLength(10);
    expect(container.querySelectorAll(".quiz-session-overlay__rank-bar > span")).toHaveLength(10);
  });

  it("hides results after their display window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(serverNow);
    const { container } = render(<QuizOverlay config={{}} state={state("results", {
      resultAt: new Date(serverNow).toISOString(),
      ranking: [],
    })} now={serverNow} language="en" />);
    expect(container.querySelector(".quiz-session-overlay")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(container.querySelector(".quiz-session-overlay")).toBeNull();
  });

  it("stays hidden for idle or malformed state", () => {
    const { container, rerender } = render(<QuizOverlay config={{}} state={null} now={serverNow} language="en" />);
    expect(container.querySelector(".quiz-session-overlay")).toBeNull();

    rerender(<QuizOverlay config={{}} state={{ phase: "idle" }} now={serverNow} language="en" />);
    expect(container.querySelector(".quiz-session-overlay")).toBeNull();
  });
});
