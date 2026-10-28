import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RealtimeEnvelope } from "../../src/realtime-contract";
import type { OverlayRealtimeCallbacks } from "../../src/overlay/realtime";
import { emoteSlotOverlayElement } from "../../src/modules/emote_slots/overlay/element";

const realtimeMocks = vi.hoisted(() => ({ connectOverlayRealtime: vi.fn() }));

vi.mock("../../src/overlay/realtime", () => realtimeMocks);
vi.mock("../../src/text", () => ({
  formatCount: (value: number, language: "de" | "en") => {
    if (value === 13) throw new Error("Fixture render failure");
    return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 0 }).format(value);
  },
}));

import { OverlayShell } from "../../src/overlay/shell";

const element = (
  id: string,
  x: number,
  y: number,
  scalePercent: number,
  z: number,
  inComposition = true,
  variableName = "score",
  kind = "variable",
) => ({
  id,
  kind,
  label: id,
  variableName,
  text: "Score: {value}",
  config: {},
  x,
  y,
  scalePercent,
  z,
  inComposition,
});

const overlayPayload = (
  value = 1200,
  css = ".brobot-overlay { color: white; }",
  includeSecond = true,
): Response => new Response(
  JSON.stringify({
    language: "en",
    overlay: {
      id: "overlay-fixture",
      revision: 1,
      width: 1920,
      height: 1080,
      css,
      elements: [
        element("element-first", 20, 30, 100, 4),
        element("element-second", 80, 90, 150, 2, includeSecond, "safe_count"),
        element("element-third", 120, 140, 75, 8, true, "safe_count"),
      ],
    },
    variables: { score: value, safe_count: 1200 },
  }),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

const slotOverlayPayload = (
  slot: { state?: Record<string, unknown> | null; moduleEnabled?: boolean; inComposition?: boolean } | null = {},
  css = "",
  revision = 1,
): Response =>
  new Response(JSON.stringify({
    language: "en",
    overlay: {
      id: "overlay-slot-fixture",
      revision,
      width: 1920,
      height: 1080,
      css,
      elements: slot === null ? [] : [{
        ...element("slot-element", 0, 0, 100, 1, slot.inComposition ?? true, "", "emote_slots.slot"),
        label: "Slot",
        variableName: null,
        text: "",
        config: {},
        state: slot.state ?? null,
        moduleEnabled: slot.moduleEnabled ?? true,
      }],
    },
    variables: {},
  }), { status: 200, headers: { "Content-Type": "application/json" } });

const quizOverlayPayload = (state: Record<string, unknown> | null): Response => new Response(JSON.stringify({
  language: "en",
  overlay: {
    id: "overlay-quiz-fixture",
    revision: 1,
    width: 1920,
    height: 1080,
    css: "",
    elements: [{
      ...element("quiz-element", 0, 0, 100, 1, true, "", "quiz.session"),
      label: "Quiz",
      variableName: null,
      text: "",
      config: {},
      state,
      moduleEnabled: true,
    }],
  },
  variables: {},
}), { status: 200, headers: { "Content-Type": "application/json" } });

const slotSpinState = {
  spinId: "spin-shell-fixture",
  login: "pixelwanderer",
  language: "en",
  outcome: "win",
  spunAt: "2030-01-01T00:00:00.000Z",
  symbols: [{ source: "emoji", code: "🍒" }, { source: "emoji", code: "🔔" }, { source: "emoji", code: "💎" }],
  net: 70,
  jackpot: 1_256,
  jackpotHit: false,
};

const createVariableMessage = (value: number): RealtimeEnvelope<"variables.changed"> => ({
  version: 1,
  id: "fixture-message",
  createdAt: "2026-09-25T08:00:00.000Z",
  channelId: "fixture-channel",
  type: "variables.changed",
  payload: { set: [{ name: "score", value }], removed: [] },
});

let realtimeCallbacks: OverlayRealtimeCallbacks | null = null;

describe("OverlayShell and OverlayCanvas", () => {
  beforeEach(() => {
    realtimeCallbacks = null;
    realtimeMocks.connectOverlayRealtime.mockReset();
    realtimeMocks.connectOverlayRealtime.mockImplementation((
      _token: string,
      _onTerminalClose: (() => void) | undefined,
      callbacks: OverlayRealtimeCallbacks,
    ) => {
      realtimeCallbacks = callbacks;
      return vi.fn();
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.head.querySelector("style[data-brobot-overlay-css]")?.remove();
  });

  it("applies quiz phase events without answer leakage and hydrates results after reconnect", async () => {
    const announce = {
      sessionId: "quiz-shell-fixture", phase: "announce", questionIndex: 0, questionCount: 2,
      question: "First question", options: ["One", "Two"], phaseEndsAt: null, paused: false, remainingMs: null,
      phaseSequence: 1, sessionStartedAt: "2029-12-31T23:59:00.000Z",
      serverNow: "2030-01-01T00:00:00.000Z",
    };
    const reveal = {
      ...announce, phase: "reveal", phaseSequence: 2, correctIndex: 1, answerDistribution: [1, 4],
    };
    const nextOpen = {
      ...announce, phase: "open", phaseSequence: 3, questionIndex: 1, question: "Second question",
      phaseEndsAt: "2030-01-01T00:00:20.000Z",
    };
    const results = {
      ...nextOpen, phase: "results", phaseSequence: 4, phaseEndsAt: null,
      resultAt: "2030-01-01T00:00:05.000Z",
      ranking: [{ login: "sampleviewer", correct: 2, rank: 1 }],
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(quizOverlayPayload(announce))
      .mockResolvedValueOnce(quizOverlayPayload(results));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector(".quiz-session-overlay")?.getAttribute("data-phase")).toBe("announce"));
    expect(container.textContent).toContain("First question");
    expect(container.textContent).not.toContain("Correct");

    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "quiz-reveal",
      createdAt: "2030-01-01T00:00:03.000Z",
      channelId: "fictional-channel",
      type: "modul.quiz.phase",
      payload: reveal,
    }));
    await waitFor(() => expect(container.querySelector("[data-correct=\"true\"]")?.textContent).toContain("Two"));

    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "quiz-next-open",
      createdAt: "2030-01-01T00:00:04.000Z",
      channelId: "fictional-channel",
      type: "modul.quiz.phase",
      payload: nextOpen,
    }));
    await waitFor(() => expect(container.querySelector(".quiz-session-overlay")?.getAttribute("data-phase")).toBe("open"));
    expect(container.textContent).toContain("Second question");
    expect(container.textContent).not.toContain("Correct");

    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector(".quiz-session-overlay")?.getAttribute("data-phase")).toBe("results"));
    expect(container.textContent).toContain("sampleviewer");
  });

  it("replays a newer quiz phase over a delayed bootstrap without rewinding its clock", async () => {
    const sessionStartedAt = "2029-12-31T23:59:00.000Z";
    const reveal = {
      sessionId: "quiz-bootstrap-race",
      phase: "reveal",
      questionIndex: 0,
      questionCount: 1,
      question: "Which answer is correct?",
      options: ["First", "Second"],
      phaseEndsAt: "2030-01-01T00:00:20.000Z",
      paused: false,
      remainingMs: null,
      phaseSequence: 2,
      sessionStartedAt,
      serverNow: "2030-01-01T00:00:11.000Z",
      correctIndex: 1,
      answerDistribution: [1, 4],
    };
    const snapshot = {
      ...reveal,
      phase: "open",
      phaseSequence: 1,
      serverNow: "2030-01-01T00:00:12.000Z",
    };
    let finishBootstrap: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(quizOverlayPayload({ ...snapshot, serverNow: "2030-01-01T00:00:10.000Z" }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishBootstrap = resolve; }));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector(".quiz-session-overlay")?.getAttribute("data-phase")).toBe("open"));
    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "quiz-reveal-before-bootstrap",
      createdAt: "2030-01-01T00:00:11.000Z",
      channelId: "fictional-channel",
      type: "modul.quiz.phase",
      payload: reveal,
    }));
    act(() => { finishBootstrap?.(quizOverlayPayload(snapshot)); });

    await waitFor(() => expect(container.querySelector(".quiz-session-overlay")?.getAttribute("data-phase")).toBe("reveal"));
    expect(container.textContent).toContain("Second");
    expect(container.querySelector(".quiz-session-overlay")?.getAttribute("data-phase")).toBe("reveal");
  });

  it("clears a canceled quiz and keeps delayed phase events from restoring it", async () => {
    const announce = {
      sessionId: "quiz-cancel-fixture",
      phase: "announce",
      questionIndex: 0,
      questionCount: 1,
      question: "Pending question",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: false,
      remainingMs: null,
      phaseSequence: 1,
      sessionStartedAt: "2030-01-01T00:00:00.000Z",
      serverNow: "2030-01-01T00:00:01.000Z",
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(quizOverlayPayload(announce)));

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector(".quiz-session-overlay")?.textContent).toContain("Pending question"));
    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "quiz-cancel",
      createdAt: "2030-01-01T00:00:02.000Z",
      channelId: "fictional-channel",
      type: "modul.quiz.cancel",
      payload: {
        sessionId: announce.sessionId,
        phase: "idle",
        phaseSequence: 2,
        sessionStartedAt: announce.sessionStartedAt,
      },
    }));
    await waitFor(() => expect(container.querySelector(".quiz-session-overlay")).toBeNull());

    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "quiz-delayed-announce",
      createdAt: "2030-01-01T00:00:03.000Z",
      channelId: "fictional-channel",
      type: "modul.quiz.phase",
      payload: announce,
    }));
    expect(container.querySelector(".quiz-session-overlay")).toBeNull();
  });

  it("refreshes an announce phase from the bootstrap after reconnect", async () => {
    const announce = {
      sessionId: "quiz-reconnect-fixture",
      phase: "announce",
      questionIndex: 0,
      questionCount: 1,
      question: "Waiting for chat",
      options: ["One", "Two"],
      phaseEndsAt: null,
      paused: true,
      remainingMs: 12_000,
      phaseSequence: 2,
      sessionStartedAt: "2030-01-01T00:00:00.000Z",
      serverNow: "2030-01-01T00:00:03.000Z",
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(quizOverlayPayload({ ...announce, paused: false, remainingMs: null, phaseSequence: 1 }))
      .mockResolvedValueOnce(quizOverlayPayload(announce));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector(".quiz-session-overlay")?.getAttribute("data-paused")).toBe("false"));
    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(container.querySelector(".quiz-session-overlay")?.getAttribute("data-paused")).toBe("true"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses one bootstrap and one socket for a three-element composition", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(overlayPayload());
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.querySelectorAll("[data-element]")).toHaveLength(3));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/overlay/bootstrap", expect.objectContaining({
      headers: { Authorization: "Bearer fictional-token" },
      cache: "no-store",
    }));
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledWith(
      "fictional-token",
      expect.any(Function),
      expect.any(Object),
      { bootstrapUrl: "/api/overlay/bootstrap" },
    );
    expect(container.querySelector(".brobot-overlay")).toHaveStyle({ width: "1920px", height: "1080px" });
    expect(container.querySelector('[data-element="element-first"]')).toHaveStyle({ left: "20px", top: "30px", zIndex: "4", width: "max-content" });
    expect(container.querySelector('[data-element="element-first"]')).toHaveClass("brobot-overlay-composition-element");
    expect(container.querySelector('[data-element="element-third"]')).toHaveStyle({ left: "120px", top: "140px", transform: "scale(0.75) translateX(var(--brobot-overlay-anchor-x, 0%))" });
    expect(container.querySelector('[data-element="element-second"]')).not.toBeNull();
    expect(container.querySelectorAll(".brobot-variable")).toHaveLength(3);
    expect(container.querySelectorAll(".brobot-variable__text")).toHaveLength(3);
    expect(container.querySelectorAll(".brobot-variable__value")).toHaveLength(3);
    await waitFor(() => expect(document.head.querySelector("style[data-brobot-overlay-css]")?.textContent)
      .toBe(".brobot-overlay { color: white; }"));
  });

  it("requests an element-scoped bootstrap for an isolated element URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(overlayPayload());
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId="element-first" />);

    await waitFor(() => expect(container.querySelector('[data-element="element-first"]')).not.toBeNull());
    expect(fetcher).toHaveBeenCalledWith("/api/overlay/bootstrap?elementId=element-first", expect.objectContaining({
      headers: { Authorization: "Bearer fictional-token" },
      cache: "no-store",
    }));
  });

  it("keeps a visible slot spin through a poll-triggered bootstrap reload and its original expiry (protects=a transient spin on an unchanged enabled element remains visible through the original presentation window after bootstrap hydration; fails_when=the poll reload clears the spin early or restarts its expiry; no_claim=spin delivery before the reload or a disabled element's presentation)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await emoteSlotOverlayElement.load();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(slotOverlayPayload())
      .mockResolvedValue(slotOverlayPayload({}, ".brobot-overlay { color: rgb(1, 2, 3); }"));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("[data-element=\"slot-element\"]")).not.toBeNull();
    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "message-slot-spin",
      createdAt: "2030-01-01T00:00:00.000Z",
      channelId: "fictional-channel",
      type: "modul.emote_slots.spin",
      payload: slotSpinState,
    }));
    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe("spin-shell-fixture");

    act(() => { vi.advanceTimersByTime(1_000); });
    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "message-poll-opened",
      createdAt: "2030-01-01T00:00:01.000Z",
      channelId: "fictional-channel",
      type: "modul.chat_voting.opened",
      payload: { pollId: "poll-fixture" },
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(document.head.querySelector("style[data-brobot-overlay-css]")?.textContent).toBe(".brobot-overlay { color: rgb(1, 2, 3); }");
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe("spin-shell-fixture");
    act(() => { vi.advanceTimersByTime(6_100); });
    expect(container.querySelector(".emote-slot-overlay")).toBeNull();
  });

  it("expires a slot spin at its original deadline after a revision remount (protects=a spin keeps its first client presentation deadline when an overlay revision remounts it; fails_when=the spin remains visible beyond the original deadline; no_claim=deadline synchronization between separate browser sources)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await emoteSlotOverlayElement.load();
    const spin = { ...slotSpinState, spinId: "spin-before-revision-fixture" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(slotOverlayPayload({ state: spin }))
      .mockResolvedValue(slotOverlayPayload({ state: spin }, ".brobot-overlay { color: white; }", 2));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe(spin.spinId);

    act(() => { vi.advanceTimersByTime(1_000); });
    act(() => realtimeCallbacks?.onOverlayChanged?.({
      version: 1,
      id: "fixture-revision-before-expiry",
      createdAt: "2030-01-01T00:00:01.000Z",
      channelId: "fixture-channel",
      type: "overlay.changed",
      payload: { overlayId: "overlay-slot-fixture", revision: 2 },
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe(spin.spinId);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_950); });
    expect(container.querySelector(".emote-slot-overlay")).toBeNull();
  });

  it("keeps an expired slot spin hidden after a revision remount (protects=an expired spin stays hidden when the same state returns in a later overlay revision; fails_when=the revision remount displays that spin again; no_claim=whether the server later emits a new spin with a different spinId)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await emoteSlotOverlayElement.load();
    const spin = { ...slotSpinState, spinId: "spin-after-expiry-fixture" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(slotOverlayPayload({ state: spin }))
      .mockResolvedValue(slotOverlayPayload({ state: spin }, ".brobot-overlay { color: white; }", 2));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe(spin.spinId);
    await act(async () => { await vi.advanceTimersByTimeAsync(7_200); });
    expect(container.querySelector(".emote-slot-overlay")).toBeNull();

    act(() => realtimeCallbacks?.onOverlayChanged?.({
      version: 1,
      id: "fixture-revision-after-expiry",
      createdAt: "2030-01-01T00:00:07.200Z",
      channelId: "fixture-channel",
      type: "overlay.changed",
      payload: { overlayId: "overlay-slot-fixture", revision: 2 },
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".emote-slot-overlay")).toBeNull();
  });

  it("retains a live spin when its enabled standalone slot reloads (protects=the standalone element URL keeps transient slot state across an unrelated bootstrap reload; fails_when=the reloaded canvas loses the active result despite the element remaining enabled; no_claim=state retention for composition elements or other module kinds)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await emoteSlotOverlayElement.load();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(slotOverlayPayload({ inComposition: false }))
      .mockResolvedValue(slotOverlayPayload({ inComposition: false }, ".brobot-overlay { color: white; }", 2));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId="slot-element" />);
    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(container.querySelector('[data-element="slot-element"]')).not.toBeNull();
    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "message-standalone-slot-spin",
      createdAt: "2030-01-01T00:00:00.000Z",
      channelId: "fictional-channel",
      type: "modul.emote_slots.spin",
      payload: { ...slotSpinState, spinId: "spin-standalone-reload-fixture" },
    }));
    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe("spin-standalone-reload-fixture");

    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "message-standalone-unrelated-update",
      createdAt: "2030-01-01T00:00:01.000Z",
      channelId: "fictional-channel",
      type: "modul.chat_voting.opened",
      payload: { pollId: "fictional-poll" },
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-element="slot-element"]')).not.toBeNull();
    expect(container.querySelector(".emote-slot-overlay")?.getAttribute("data-spin-id")).toBe("spin-standalone-reload-fixture");
  });

  it.each(["disabled", "removed"] as const)("drops a transient slot spin when its element is %s (protects=transient state is discarded when the same enabled element is disabled or removed; fails_when=reenabling or restoring the element revives its old spin; no_claim=state persistence for other overlay element kinds)", async (change) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await emoteSlotOverlayElement.load();
    const secondBootstrap = change === "removed" ? slotOverlayPayload(null) : slotOverlayPayload({ moduleEnabled: false });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(slotOverlayPayload())
      .mockResolvedValueOnce(secondBootstrap)
      .mockResolvedValue(slotOverlayPayload());
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id: "message-slot-spin-before-drop",
      createdAt: "2030-01-01T00:00:00.000Z",
      channelId: "fictional-channel",
      type: "modul.emote_slots.spin",
      payload: slotSpinState,
    }));
    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(container.querySelector(".emote-slot-overlay")).not.toBeNull();
    const triggerPollReload = (id: string): void => realtimeCallbacks?.onModuleMessage?.({
      version: 1,
      id,
      createdAt: "2030-01-01T00:00:01.000Z",
      channelId: "fictional-channel",
      type: "modul.chat_voting.opened",
      payload: { pollId: id },
    });

    act(() => triggerPollReload("message-slot-drop"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".emote-slot-overlay")).toBeNull();

    act(() => triggerPollReload("message-slot-restore"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(container.querySelector(".emote-slot-overlay")).toBeNull();
  });

  it("merges voting tallies in the shell and keeps closed overlay state after delayed messages", async () => {
    const localNow = Date.now();
    const bootstrap = {
      language: "en",
      overlay: {
        id: "voting-overlay",
        revision: 1,
        width: 1920,
        height: 1080,
        css: "",
        elements: [{
          id: "voting-element",
          kind: "chat_voting.tally",
          label: "Voting",
          variableName: null,
          text: "",
          config: { layout: "bars", showPercent: true, showCountdown: true, hideAfterCloseSeconds: 15 },
          state: {
            pollId: "poll-a",
            openedAt: new Date(localNow).toISOString(),
            closesAt: new Date(localNow + 90_000).toISOString(),
            requestedDurationSeconds: 90,
            status: "open",
            labels: ["Yes", "No"],
            counts: [0, 0],
            revision: 0,
          },
          moduleEnabled: true,
          x: 0,
          y: 0,
          scalePercent: 100,
          z: 0,
          inComposition: true,
        }],
      },
      variables: {},
    };
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(bootstrap), { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.textContent).toContain("Yes"));
    expect(container.querySelector(".chat-voting-tally__countdown")).toHaveTextContent("1:30");
    const send = (type: `modul.${string}.${string}`, payload: Readonly<Record<string, unknown>>): void => {
      const revision = payload.revision;
      const messageId = typeof revision === "number" ? String(revision) : "closed";
      act(() => realtimeCallbacks?.onModuleMessage?.({
        version: 1,
        id: `message-${type}-${messageId}`,
        createdAt: "2030-01-01T00:00:30.000Z",
        channelId: "fictional-channel",
        type,
        payload,
      }));
    };

    send("modul.chat_voting.tally", { pollId: "poll-a", openedAt: "2030-01-01T00:00:00.000Z", counts: [5, 2], revision: 5 });
    await waitFor(() => expect(container.textContent).toContain("5 · 71%"));
    expect(container.querySelector(".chat-voting-tally__countdown")).toHaveTextContent("1:30");
    send("modul.chat_voting.tally", { pollId: "poll-a", counts: [3, 1], revision: 3 });
    await waitFor(() => expect(container.textContent).toContain("5 · 71%"));
    expect(container.textContent).not.toContain("3 · 75%");

    send("modul.chat_voting.tally", {
      pollId: "poll-a",
      openedAt: "2030-01-01T00:00:00.000Z",
      status: "closed",
      counts: [4, 2],
      revision: 0,
      closedAt: "2030-01-01T00:00:00.000Z",
      closeReason: "manual",
    });
    await waitFor(() => expect(container.querySelector('[aria-label="Results"]')).not.toBeNull());
    send("modul.chat_voting.tally", { pollId: "poll-a", openedAt: "2030-01-01T00:00:00.000Z", counts: [8, 2], revision: 8 });

    await waitFor(() => expect(container.textContent).toContain("4 · 67%"));
    expect(container.querySelector('[aria-label="Results"]')).not.toBeNull();
    expect(container.textContent).toContain("Yes");
    expect(container.textContent).not.toContain("8 · 80%");

    send("modul.chat_voting.tally", {
      pollId: "poll-b",
      openedAt: "2030-01-01T00:01:00.000Z",
      status: "open",
      labels: ["Up", "Down"],
      counts: [0, 0],
      revision: 0,
    });
    await waitFor(() => expect(container.textContent).toContain("Up"));
    send("modul.chat_voting.tally", {
      pollId: "poll-a",
      openedAt: "2030-01-01T00:00:00.000Z",
      status: "closed",
      counts: [9, 0],
      revision: 0,
      closedAt: "2030-01-01T00:02:00.000Z",
    });
    await waitFor(() => expect(container.textContent).toContain("Up"));
    expect(container.querySelector('[aria-label="Results"]')).toBeNull();
    expect(container.textContent).not.toContain("9 · 100%");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("applies buffered tally data without changing the bootstrap close time", async () => {
    const localNow = Date.parse("2030-01-01T00:00:10.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => localNow);
    const bootstrapResponse = (revision: number): Response => new Response(JSON.stringify({
      language: "en",
      overlay: {
        id: "voting-overlay",
        revision: 1,
        width: 1920,
        height: 1080,
        css: "",
        elements: [{
          id: "voting-element",
          kind: "chat_voting.tally",
          label: "Voting",
          variableName: null,
          text: "",
          config: { layout: "bars", showPercent: true, showCountdown: true },
          state: {
            pollId: "poll-sync",
            openedAt: "2030-01-01T00:00:00.000Z",
            closesAt: "2030-01-01T00:01:30.000Z",
            requestedDurationSeconds: 90,
            status: "open",
            preset: "yes_no",
            optionCount: 2,
            labels: ["Yes", "No"],
            counts: [0, 0],
            revision,
          },
          moduleEnabled: true,
          x: 0,
          y: 0,
          scalePercent: 100,
          z: 0,
          inComposition: true,
        }],
      },
      variables: {},
    }), { status: 200 });
    let finishRefresh: ((response: Response) => void) | null = null;
    const refreshResponse = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(bootstrapResponse(0))
      .mockReturnValueOnce(refreshResponse);
    vi.stubGlobal("fetch", fetcher);

    try {
      const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
      await waitFor(() => expect(container.querySelector(".chat-voting-tally__countdown")).toHaveTextContent("1:20"));

      act(() => realtimeCallbacks?.onOpen?.(true));
      expect(fetcher).toHaveBeenCalledTimes(2);
      act(() => realtimeCallbacks?.onModuleMessage?.({
        version: 1,
        id: "buffered-tally-update",
        createdAt: "2030-01-01T00:00:01.000Z",
        channelId: "fictional-channel",
        type: "modul.chat_voting.tally",
        payload: { pollId: "poll-sync", counts: [1, 0], revision: 1 },
      }));

      await act(async () => {
        finishRefresh?.(bootstrapResponse(0));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => expect(container.textContent).toContain("1 · 100%"));
      expect(container.querySelector(".chat-voting-tally__countdown")).toHaveTextContent("1:20");
    } finally {
      cleanup();
      nowSpy.mockRestore();
    }
  });

  it("replaces rendered voting state with bootstrap snapshots, including null, and hides closed results on time", async () => {
    const responseFor = (state: Readonly<Record<string, unknown>> | null): Response => new Response(JSON.stringify({
      language: "en",
      overlay: {
        id: "voting-overlay",
        revision: 1,
        width: 1920,
        height: 1080,
        css: "",
        elements: [{
          id: "voting-element",
          kind: "chat_voting.tally",
          label: "Voting",
          variableName: null,
          text: "",
          config: { layout: "bars", showPercent: true, hideAfterCloseSeconds: 1 },
          state,
          moduleEnabled: true,
          x: 0,
          y: 0,
          scalePercent: 100,
          z: 0,
          inComposition: true,
        }],
      },
      variables: {},
    }), { status: 200 });
    const open = {
      pollId: "poll-a",
      openedAt: "2030-01-01T00:00:00.000Z",
      status: "open",
      labels: ["Yes", "No"],
      counts: [7, 0],
      revision: 7,
    };
    const closed = {
      ...open,
      status: "closed",
      counts: [4, 2],
      revision: 0,
      closedAt: "2030-01-01T00:01:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(responseFor(open))
      .mockResolvedValueOnce(responseFor(closed))
      .mockResolvedValueOnce(responseFor(null))
      .mockImplementationOnce(() => Promise.resolve(responseFor({
        ...closed,
        closedAt: new Date().toISOString(),
      })));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.textContent).toContain("7 · 100%"));
    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(container.textContent).toContain("4 · 67%"));
    expect(container.querySelector('[aria-label="Results"]')).not.toBeNull();

    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(container.querySelector(".chat-voting-tally")).toBeNull());

    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(container.querySelector('[aria-label="Results"]')).not.toBeNull());
    await waitFor(() => expect(container.querySelector(".chat-voting-tally")).toBeNull(), { timeout: 2_500 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("refreshes a connected source before a supplied state timeline expires", async () => {
    vi.useFakeTimers();
    const serverNow = "2026-09-27T12:00:00.000Z";
    vi.setSystemTime(Date.parse(serverNow));
    const payload = {
      language: "en",
      overlay: {
        id: "overlay-fixture", revision: 1, width: 1920, height: 1080, css: "",
        elements: [{ ...element("text-block", 0, 0, 100, 0), state: {
          serverNow,
          refreshAt: "2026-09-27T12:00:30.000Z",
        } }],
      },
      variables: {},
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    render(<OverlayShell token="fictional-token" elementId={null} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps a denied bootstrap transparent when a legacy debug fragment is present", async () => {
    window.history.replaceState(null, "", "/overlay#token=fictional-token&debug=1");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one selected element at the origin with its stored scale", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(1200, ".brobot-overlay { color: white; }", false)));

    const { container } = render(<OverlayShell token="fictional-token" elementId="element-second" />);

    await waitFor(() => expect(container.querySelector('[data-element="element-second"]')).not.toBeNull());
    expect(container.querySelectorAll("[data-element]")).toHaveLength(1);
    const isolatedElement = container.querySelector('[data-element="element-second"]');
    expect(isolatedElement).toHaveStyle({
      left: "0px",
      top: "0px",
      transform: "scale(1.5)",
    });
    // Isolated/legacy rendering (e.g. an unbound #text= link in a narrow OBS browser source)
    // keeps its original shrink-to-fit/wrap behavior: no forced width, no composition class.
    expect(isolatedElement).not.toHaveClass("brobot-overlay-composition-element");
    expect(isolatedElement?.getAttribute("style")).not.toContain("max-content");
  });

  it("renders stored text for a bound legacy token and ignores fragment configuration", async () => {
    window.history.replaceState(null, "", "/overlay#token=fictional-token&var=score&text=Fragment%20override%3A%20%7Bvalue%7D");
    const payload = {
      language: "en",
      overlay: {
        id: "imported-overlay", revision: 1, width: 1920, height: 1080, css: "",
        elements: [{ ...element("imported-element", 0, 0, 100, 0), text: "Imported: {value}" }],
      },
      variables: { score: 1200 },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.querySelector('[data-element="imported-element"]')).not.toBeNull());
    expect(container.querySelector('[data-element="imported-element"] .brobot-variable__text')).toHaveTextContent("Imported:");
    expect(container).not.toHaveTextContent("Fragment override");
    expect(fetcher).toHaveBeenCalledWith("/api/overlay/bootstrap", expect.objectContaining({
      headers: { Authorization: "Bearer fictional-token" },
    }));
  });

  it.each([
    ["without a placeholder", "Legacy score"],
    ["with multiple placeholders", "Legacy {value} plus {value}"],
  ])("preserves legacy rendering %s after the token is bound", async (_description, legacyText) => {
    const fragment = new URLSearchParams({ token: "fictional-token", var: "score", text: legacyText });
    window.history.replaceState(null, "", `/overlay#${fragment.toString()}`);
    let bootstrapRequests = 0;
    const boundPayload = {
      language: "en",
      overlay: {
        id: "imported-overlay", revision: 1, width: 1920, height: 1080, css: "",
        elements: [{ ...element("imported-element", 0, 0, 100, 0), text: legacyText }],
      },
      variables: { score: 1200 },
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (input === "/api/overlay/bootstrap") {
        bootstrapRequests += 1;
        return Promise.resolve(new Response(JSON.stringify(bootstrapRequests === 1
          ? { language: "en", overlay: null, variables: { score: 1200 } }
          : boundPayload), { status: 200 }));
      }
      if (input === "/api/overlay/variables/score") {
        return Promise.resolve(new Response(JSON.stringify({ name: "score", value: 1200 }), {
          status: 200,
          headers: { "Content-Language": "en" },
        }));
      }
      const requestDescription = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      return Promise.reject(new Error(`Unexpected request ${requestDescription}.`));
    });
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(realtimeCallbacks?.onTokenBound).toBeTypeOf("function"));
    await waitFor(() => expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("1,200"));
    const legacyRendering = container.textContent;
    const legacyCallbacks = realtimeCallbacks;

    act(() => legacyCallbacks?.onTokenBound?.());

    await waitFor(() => expect(container.querySelector('[data-element="imported-element"]')).not.toBeNull());
    expect(bootstrapRequests).toBe(2);
    expect(container.textContent).toBe(legacyRendering);
  });

  it("updates live values, debounces overlay changes, and reloads after reconnect", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(overlayPayload()));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("1,200");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1);
    expect(realtimeCallbacks?.onMessage).toBeTypeOf("function");

    act(() => realtimeCallbacks?.onMessage?.(createVariableMessage(3400)));
    await waitFor(() => expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("3,400"));
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    act(() => realtimeCallbacks?.onOverlayChanged?.({
      version: 1,
      id: "fixture-change",
      createdAt: "2026-09-25T08:00:00.000Z",
      channelId: "fixture-channel",
      type: "overlay.changed",
      payload: { overlayId: "overlay-fixture", revision: 2 },
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);

    act(() => realtimeCallbacks?.onOpen?.(true));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps a live variable update newer than an in-flight bootstrap response", async () => {
    let finishReload: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(overlayPayload(1200))
      .mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector('[data-element="element-first"]')).not.toBeNull());
    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    act(() => realtimeCallbacks?.onMessage?.(createVariableMessage(3400)));
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("3,400");
    await act(async () => {
      finishReload?.(overlayPayload(1200));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("3,400"));
  });

  it("reconciles the initial bootstrap after the first successful socket open", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(overlayPayload());
    vi.stubGlobal("fetch", fetcher);

    render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    act(() => realtimeCallbacks?.onOpen?.(false));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("installs a pre-connect bootstrap and reconciles after reconnect", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(1200));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector('[data-element="element-first"]')).not.toBeNull());
    const preconnectPayload: unknown = JSON.parse(await overlayPayload(3400).text());
    let bootstrapReused = false;
    act(() => {
      bootstrapReused = realtimeCallbacks?.onBootstrap?.(preconnectPayload) ?? false;
    });

    expect(bootstrapReused).toBe(true);
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')?.textContent).toContain("3,400");
    act(() => realtimeCallbacks?.onOpen?.(true, true));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("keeps the last rendered content through a transient bootstrap reload failure and retries", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(overlayPayload(1200))
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(overlayPayload(3400));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.querySelector("[data-element]")).not.toBeNull());
    vi.useFakeTimers();
    act(() => realtimeCallbacks?.onOpen?.(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-element]")).not.toBeNull();
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("1,200");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("3,400");
  });

  it("clears rendered content after revocation while the source is disconnected", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload()));
    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector("[data-element]")).not.toBeNull());
    const terminalClose = realtimeMocks.connectOverlayRealtime.mock.calls[0]?.[1] as (() => void) | undefined;

    act(() => terminalClose?.());

    expect(container.querySelector("[data-element]")).toBeNull();
    act(() => realtimeCallbacks?.onOpen?.(true));
    expect(container.querySelector("[data-element]")).toBeNull();
  });

  it("keeps revoked sources transparent when an active bootstrap finishes", async () => {
    let finishBootstrap: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(overlayPayload())
      .mockImplementationOnce(() => new Promise((resolve) => { finishBootstrap = resolve; }));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector("[data-element]")).not.toBeNull());
    await waitFor(() => expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1));
    const terminalClose = realtimeMocks.connectOverlayRealtime.mock.calls[0]?.[1] as (() => void) | undefined;
    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const activeSignal = fetcher.mock.calls[1]?.[1]?.signal;
    act(() => terminalClose?.());
    expect(activeSignal?.aborted).toBe(true);
    await act(async () => {
      finishBootstrap?.(overlayPayload());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-element]")).toBeNull();
    act(() => realtimeCallbacks?.onOpen?.(false));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-element]")).toBeNull();
  });

  it("cancels queued reloads and coalesces reconnects while a bootstrap is in flight", async () => {
    vi.useFakeTimers();
    let finishReload: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(overlayPayload())
      .mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }))
      .mockResolvedValue(overlayPayload());
    vi.stubGlobal("fetch", fetcher);

    render(<OverlayShell token="fictional-token" elementId={null} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    act(() => realtimeCallbacks?.onOverlayChanged?.({
      version: 1,
      id: "fixture-change",
      createdAt: "2026-09-25T08:00:00.000Z",
      channelId: "fixture-channel",
      type: "overlay.changed",
      payload: { overlayId: "overlay-fixture", revision: 2 },
    }));
    act(() => realtimeCallbacks?.onOpen?.(true));
    expect(fetcher).toHaveBeenCalledTimes(2);
    act(() => realtimeCallbacks?.onOpen?.(true));
    act(() => realtimeCallbacks?.onOpen?.(true));
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      finishReload?.(overlayPayload());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("lets the legacy entry own the only realtime connection for an unbound link", async () => {
    window.history.replaceState(null, "", "/overlay#token=fictional-token&var=score&text=%7Bvalue%7D");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ language: "en", overlay: null, variables: {} }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ name: "score", value: 12 }), { status: 200, headers: { "Content-Language": "en" } }));
    vi.stubGlobal("fetch", fetcher);

    render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => input === "/api/overlay/variables/score")).toBe(true));
    expect(fetcher).toHaveBeenCalledWith("/api/overlay/bootstrap", expect.anything());
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1);
  });

  it("recovers an element boundary after its rendered value changes", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(13)));

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelectorAll("[data-element]")).toHaveLength(2));
    act(() => realtimeCallbacks?.onMessage?.(createVariableMessage(1200)));

    await waitFor(() => expect(container.querySelectorAll("[data-element]")).toHaveLength(3));
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("1,200");
  });

  it("keeps a missing constructor variable transparent", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      language: "en",
      overlay: {
        id: "overlay-fixture", revision: 1, width: 1920, height: 1080, css: "",
        elements: [element("element-constructor", 0, 0, 100, 0, true, "constructor")],
      },
      variables: {},
    }), { status: 200 })));

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector(".brobot-overlay")).not.toBeNull());

    expect(container.querySelector("[data-element]")).toBeNull();
  });

  it("keeps sibling elements visible when one variable element throws", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(13)));

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.querySelectorAll(".brobot-variable__value")).toHaveLength(2));
    expect(container.querySelectorAll("[data-element]")).toHaveLength(2);
    expect(container).toHaveTextContent("1,200");
  });

  it("leaves unknown standalone element IDs transparent", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload()));

    const { container } = render(<OverlayShell token="fictional-token" elementId="unknown-element" />);

    await waitFor(() => expect(document.head.querySelector("style[data-brobot-overlay-css]")).not.toBeNull());
    expect(container).toBeEmptyDOMElement();
  });

  it("strips imports and remote CSS URLs before injection while retaining relative assets", async () => {
    const css = '@import url("https://assets.example/theme.css"); .brobot-overlay { background: url("https://assets.example/image.png"); mask: url("../assets/mask.svg"); }';
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(1200, css)));

    render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(document.head.querySelector("style[data-brobot-overlay-css]")?.textContent)
      .toContain("../assets/mask.svg"));
    const installedCss = document.head.querySelector("style[data-brobot-overlay-css]")?.textContent ?? "";
    expect(installedCss).not.toContain("@import");
    expect(installedCss).not.toContain("https://assets.example");
  });
});
