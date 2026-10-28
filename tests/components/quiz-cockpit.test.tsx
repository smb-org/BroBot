import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuizLiveTile } from "../../src/modules/quiz/panel/live-tile";
import QuizStartActionContent from "../../src/modules/quiz/panel/start-action-content";

const session = {
  kind: "quiz" as const,
  sessionId: "session-one",
  setName: "Space",
  phase: "open" as const,
  questionIndex: 0,
  questionCount: 2,
  paused: false,
  phaseEndsAt: new Date(Date.now() + 30_000).toISOString(),
};
const requestedActions = (requests: readonly { body: string }[]): Array<{ action: string; sessionId: string | null }> => requests.map(({ body }) => {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { action: "", sessionId: null };
  const request = parsed as Record<string, unknown>;
  return {
    action: typeof request.action === "string" ? request.action : "",
    sessionId: typeof request.sessionId === "string" ? request.sessionId : null,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("quiz cockpit controls", () => {
  it("loads enabled question sets and reports when the start action is ready", async () => {
    const readiness = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString(), window.location.href);
      return Promise.resolve(url.pathname.endsWith("/session/sets")
        ? Response.json({ sets: [{ id: "space", name: "Space", enabledQuestionCount: 2 }] })
        : Response.json({ error: "unexpected_request" }, { status: 500 }));
    }));

    render(<QuizStartActionContent channelId="channel-one" language="en" onReadinessChange={readiness} />);

    expect(await screen.findByRole("combobox", { name: "Question set" })).toBeTruthy();
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(true, null));
    expect(screen.getByRole("combobox", { name: "Questions" })).toBeTruthy();
  });

  it("sends pause, resume, next, and end from the running tile", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const onRefresh = vi.fn();
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "/api/csrf") return Promise.resolve(Response.json({ token: "csrf-token" }));
      requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<QuizLiveTile channelId="channel-one" language="en" session={session} streamState="online" now={Date.now()} canManage onRefresh={onRefresh} onMessage={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(requestedActions(requests)).toEqual([{ action: "pause", sessionId: "session-one" }]));
    rerender(<QuizLiveTile channelId="channel-one" language="en" session={{ ...session, paused: true }} streamState="online" now={Date.now()} canManage onRefresh={onRefresh} onMessage={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(requestedActions(requests)).toEqual([
      { action: "pause", sessionId: "session-one" },
      { action: "resume", sessionId: "session-one" },
    ]));
    rerender(<QuizLiveTile channelId="channel-one" language="en" session={{ ...session, paused: false }} streamState="online" now={Date.now()} canManage onRefresh={onRefresh} onMessage={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(requestedActions(requests)).toEqual([
      { action: "pause", sessionId: "session-one" },
      { action: "resume", sessionId: "session-one" },
      { action: "next", sessionId: "session-one" },
    ]));
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    await waitFor(() => expect(requestedActions(requests)).toEqual([
      { action: "pause", sessionId: "session-one" },
      { action: "resume", sessionId: "session-one" },
      { action: "next", sessionId: "session-one" },
      { action: "end", sessionId: "session-one" },
    ]));

    expect(requests.every(({ url }) => url.endsWith("/session/action"))).toBe(true);
    expect(onRefresh).toHaveBeenCalledTimes(4);
  });

  it("disables all actions in the results phase while keeping the layout stable", () => {
    render(<QuizLiveTile channelId="channel-one" language="en" session={{ ...session, phase: "results", phaseEndsAt: null }} streamState="online" now={Date.now()} canManage onRefresh={vi.fn()} onMessage={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Pause" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "End" }).hasAttribute("disabled")).toBe(true);
  });

  it.each([
    ["offline", "offline"],
    ["unknown", null],
  ] as const)("allows only End while the stream is %s", (_label, streamState) => {
    render(<QuizLiveTile channelId="channel-one" language="en" session={{ ...session, paused: true }} streamState={streamState} now={Date.now()} canManage onRefresh={vi.fn()} onMessage={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Resume" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "End" }).hasAttribute("disabled")).toBe(false);
  });
});
