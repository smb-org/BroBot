import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelVariablesPage } from "../../src/dashboard/ChannelVariablesPage";
import { UiProvider } from "../../src/dashboard/ui";
import { jsonResponse } from "../unit/fixtures";
import { TestWebSocket } from "./test-websocket";

const variable = {
  channelId: "kanal-a",
  name: "score",
  value: 1234,
  description: "Current score",
  resetOnStreamStart: true,
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
  usages: [],
};

const setBrowserLanguage = (language: string): void => {
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
};

describe("Channel variables page", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    TestWebSocket.instances = [];
    setBrowserLanguage("de-DE");
  });

  it("shows a spaced table, reset indicator, quick controls, and disabled Save for operators", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse({
      variables: [variable], count: 1, maximum: 25,
    })));
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage={false} onOpenCommand={() => {}} /></UiProvider>);

    const table = await screen.findByRole("table");
    expect(table.querySelectorAll("thead th")).toHaveLength(4);
    expect(table.querySelector("tbody th")).toHaveClass("mono");
    expect(table.querySelector(".channel-variables-table__description")).toHaveClass("channel-variables-table__description");
    expect(table.querySelector(".channel-variables-table__value")).toHaveClass("number");
    expect(screen.getByLabelText("Bei Streamstart auf null setzen")).toBeInTheDocument();
    expect(screen.getByText("Bis zu 25 Variablen pro Kanal.")).toBeInTheDocument();

    const row = table.querySelector("tbody tr");
    if (row === null) throw new Error("Channel variable row is missing.");
    fireEvent.click(row);

    const inspector = document.querySelector(".list-detail__inspector");
    if (!(inspector instanceof HTMLElement)) throw new Error("Variable inspector is missing.");
    const controls = within(inspector);
    const resetSwitch = controls.getByRole("switch", { name: "Bei Streamstart auf null setzen" });
    expect(resetSwitch.closest(".ui-switch-card")).toBeInTheDocument();
    expect(resetSwitch.closest(".ui-switch")).toBeNull();
    const resetCard = resetSwitch.closest(".ui-switch-card");
    if (!(resetCard instanceof HTMLElement)) throw new Error("Reset switch card is missing.");
    expect(within(resetCard).getByText("Wird zurückgesetzt, wenn der nächste Stream startet.")).toBeInTheDocument();
    const permissionNote = inspector.querySelector(".switch-locked-reason");
    if (!(permissionNote instanceof HTMLElement)) throw new Error("Reset switch permission note is missing.");
    expect(permissionNote).toHaveAttribute("role", "note");
    expect(permissionNote).toHaveTextContent(/Nur Broadcaster und Verwalter dürfen Variablen/u);
    expect(resetCard).not.toContainElement(permissionNote);
    expect(await controls.findByRole("button", { name: "+1" })).toBeInTheDocument();
    expect(controls.getByRole("button", { name: "−1" })).toBeInTheDocument();
    expect(controls.getByRole("spinbutton", { name: "Setzen auf" })).toBeInTheDocument();
    expect(controls.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(controls.getByRole("button", { name: "Speichern" })).toHaveAttribute("title", expect.stringContaining("Nur Broadcaster"));
    expect(screen.queryByText("Overlay-Link")).not.toBeInTheDocument();
  });

  it("opens an existing overlay editor with the variable as an unsaved draft", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method });
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      if (url.pathname === "/api/channels/kanal-a/overlays") return Promise.resolve(jsonResponse({
        overlays: [{ id: "overlay-a", name: "Gameplay", width: 1920, height: 1080, revision: 2, elementCount: 1 }],
        maximum: 20,
        elementMaximum: 20,
      }));
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    const onOpenOverlay = vi.fn();
    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} onOpenOverlay={onOpenOverlay} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.click(screen.getByRole("button", { name: "In Overlay verwenden" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editor öffnen" }));

    expect(onOpenOverlay).toHaveBeenCalledWith("overlay-a", "score");
    expect(requests.some(({ path, method }) => path.endsWith("/overlays/overlay-a") && method !== "GET")).toBe(false);
    expect(requests.some(({ path }) => path.endsWith("/overlays/overlay-a"))).toBe(false);
  });

  it("creates an empty overlay shell before opening the editor with a variable draft", async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      if (url.pathname === "/api/channels/kanal-a/overlays" && method === "GET") return Promise.resolve(jsonResponse({ overlays: [], maximum: 20, elementMaximum: 20 }));
      if (url.pathname === "/api/channels/kanal-a/overlays" && method === "POST") return Promise.resolve(jsonResponse({ overlay: {
        id: "overlay-new", channelId: "kanal-a", name: "score overlay", width: 1920, height: 1080, css: "", revision: 1,
        createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z", elements: [],
      } }, 201));
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    const onOpenOverlay = vi.fn();
    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} onOpenOverlay={onOpenOverlay} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.click(screen.getByRole("button", { name: "In Overlay verwenden" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editor öffnen" }));

    await vi.waitFor(() => { expect(onOpenOverlay).toHaveBeenCalledWith("overlay-new", "score"); });
    const create = requests.find(({ path, method }) => path.endsWith("/overlays") && method === "POST");
    expect(create?.body).toBe(JSON.stringify({ name: "score overlay", width: 1920, height: 1080 }));
    expect(requests.some(({ method }) => method === "PUT")).toBe(false);
  });

  it("shows a reconnect hint without rebinding automatically and reconnects through a revision save", async () => {
    const detached = { ...variable, usages: [{ moduleId: "overlays", itemName: "Gameplay", elementLabel: "Score", kind: "display" as const, overlayId: "overlay-a", elementId: "element-a", reconnect: true }] };
    const overlay = {
      id: "overlay-a", channelId: "kanal-a", name: "Gameplay", width: 1920, height: 1080, css: "", revision: 4,
      createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
      elements: [{ id: "element-a", kind: "variable", label: "Score", variableName: null, missingVariableName: "score", text: "Score: {value}", config: {}, x: 0, y: 0, scalePercent: 100, z: 0, inComposition: true }],
    };
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [detached], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && method === "GET") return Promise.resolve(jsonResponse({ overlay }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && method === "PUT") return Promise.resolve(jsonResponse({ overlay: { ...overlay, revision: 5 } }));
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));

    expect(screen.getByRole("button", { name: "Gameplay → Score" })).toBeInTheDocument();
    expect(screen.getByText(/Variable fehlt — neu wählen/u)).toBeInTheDocument();
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Neu verbinden" }));
    await vi.waitFor(() => { expect(requests.some((request) => request.method === "PUT")).toBe(true); });
    const save = requests.find((request) => request.method === "PUT");
    expect(save?.body).toContain('"variableName":"score"');
    expect(save?.body).toContain('"baseRevision":4');
    expect(save?.body).toContain('"reconnectExpectation":{"elementId":"element-a","missingVariableName":"score"}');
  });

  it("shows the reconnect action disabled with a reason for operators", async () => {
    const detached = { ...variable, usages: [{ moduleId: "overlays", itemName: "Gameplay → Score", kind: "display" as const, overlayId: "overlay-a", elementId: "element-a", reconnect: true }] };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      return Promise.resolve(url.pathname.endsWith("/overlay-tokens")
        ? jsonResponse({ tokens: [], nextOffset: null })
        : jsonResponse({ variables: [detached], count: 1, maximum: 25 }));
    }));
    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage={false} onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    expect(screen.getByRole("button", { name: "Neu verbinden" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Neu verbinden" })).toHaveAttribute("title", expect.stringContaining("Nur Broadcaster"));
  });

  it("refuses to reconnect an element that the latest overlay response already binds to another variable", async () => {
    const detached = { ...variable, usages: [{ moduleId: "overlays", itemName: "Gameplay → Score", kind: "display" as const, overlayId: "overlay-a", elementId: "element-a", reconnect: true }] };
    const overlay = {
      id: "overlay-a", channelId: "kanal-a", name: "Gameplay", width: 1920, height: 1080, css: "", revision: 5,
      createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
      elements: [{ id: "element-a", kind: "variable", label: "Score", variableName: "other", missingVariableName: null, text: "Other: {value}", config: {}, x: 0, y: 0, scalePercent: 100, z: 0, inComposition: true }],
    };
    const requests: Array<{ path: string; method: string }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method });
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [detached], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && method === "GET") return Promise.resolve(jsonResponse({ overlay }));
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.click(screen.getByRole("button", { name: "Neu verbinden" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Das Overlay-Element wurde inzwischen geändert.");
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it.each([
    ["de-DE", "Alte Links mit #var=… zeigen diese Variable nach der Umbenennung nicht mehr an."],
    ["en-US", "Old links using #var=… will stop showing this variable after it is renamed."],
  ])("warns about old fragment links in %s when legacy links exist", async (language, expectedWarning) => {
    setBrowserLanguage(language);
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [{ id: "legacy-link-a", name: null, createdAt: "2026-09-24T00:00:00.000Z", createdBy: "Sample creator", lastUsedAt: null, expiresAt: null }], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "points" } });

    expect(await screen.findByText(expectedWarning)).toBeInTheDocument();
  });

  it("coalesces variable hints, bounds continuous refreshes, and keeps one request in flight", async () => {
    let releaseThird: ((result: Response) => void) | null = null;
    let variableRequestCount = 0;
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/overlay-tokens")) return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      variableRequestCount++;
      return variableRequestCount === 3
        ? new Promise((resolve) => { releaseThird = resolve; })
        : Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestWebSocket);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    await screen.findByRole("table");
    expect(TestWebSocket.instances).toHaveLength(1);
    vi.useFakeTimers();
    TestWebSocket.instances[0]?.dispatch("open", new Event("open"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(variableRequestCount).toBe(2);

    const sendHint = (id: number): void => TestWebSocket.instances[0]?.dispatch("message", {
      data: JSON.stringify({
        version: 1,
        id: `variables-changed-${String(id)}`,
        createdAt: "2026-09-24T12:00:00.000Z",
        channelId: "kanal-a",
        type: "variables.changed",
        payload: { set: [{ name: "score", value: 1235 }], removed: [] },
      }),
    } as MessageEvent<string>);
    for (let index = 0; index < 10; index++) sendHint(index);
    await act(async () => { await vi.advanceTimersByTimeAsync(119); });
    expect(variableRequestCount).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(variableRequestCount).toBe(3);

    for (let index = 10; index < 25; index++) {
      sendHint(index);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(variableRequestCount).toBe(3);
    expect(releaseThird).toBeTypeOf("function");
    await act(async () => {
      releaseThird?.(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(variableRequestCount).toBe(4);
    fireEvent.focus(window);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("consumes each Spotlight selection, applies later requests on the mounted page, and does not replay one after returning", async () => {
    const other = { ...variable, name: "other", description: "" };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse({
      variables: [other, variable], count: 2, maximum: 25,
    }))));

    const Harness = (): ReactElement => {
      const [selection, setSelection] = useState<string | null>("score");
      const [visible, setVisible] = useState(true);
      return <>
        <button type="button" onClick={() => setSelection("other")}>Request other variable</button>
        <button type="button" onClick={() => setVisible(false)}>Leave variables</button>
        <button type="button" onClick={() => setVisible(true)}>Return to variables</button>
        {visible ? <ChannelVariablesPage
          channelId="kanal-a"
          canManage={false}
          onOpenCommand={() => {}}
          {...(selection === null ? {} : { initialSelection: selection })}
          onInitialSelectionConsumed={(name) => { setSelection((pending) => pending === name ? null : pending); }}
        /> : null}
      </>;
    };
    render(<UiProvider><Harness /></UiProvider>);

    await screen.findByText("{var.score}");
    const nameField = await screen.findByLabelText("Name");
    expect(nameField).toHaveValue("score");

    fireEvent.click(screen.getByRole("button", { name: "Request other variable" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("other");

    fireEvent.click(screen.getByRole("button", { name: "Leave variables" }));
    fireEvent.click(screen.getByRole("button", { name: "Return to variables" }));
    await screen.findByRole("table");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
});
