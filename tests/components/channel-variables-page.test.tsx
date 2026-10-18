import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelVariablesPage } from "../../src/dashboard/ChannelVariablesPage";
import type { PanelChannelVariablesResponse } from "../../src/dashboard/api";
import { UiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { reconcileDashboardRealtimeMessage } from "../../src/dashboard/data/realtime";
import { dashboardDataKeys } from "../../src/dashboard/data/keys";
import type { RealtimeMessage } from "../../src/realtime-contract";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery as render } from "../query-test-utils";

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
    for (const toast of toastsSnapshot()) dismissToast(toast.id);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setBrowserLanguage("de-DE");
  });

  it("keeps the variable save cluster in the fixed editor header", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse({
      variables: [variable], count: 1, maximum: 25,
    }))));

    const { container } = render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));

    const header = container.querySelector(".channel-variable-editor__header .page-header");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByRole("button", { name: "Verwerfen" })).toBeDisabled();
    expect(within(header as HTMLElement).getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(container.querySelector(".inspector-actions")).toBeNull();
  });

  it("saves an edited value with the definition before switching to another variable", async () => {
    const otherVariable = { ...variable, name: "other", value: 7, description: "Other value", resetOnStreamStart: false };
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    let savedVariable = variable;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables" && method === "GET") {
        return Promise.resolve(jsonResponse({ variables: [savedVariable, otherVariable], count: 2, maximum: 25 }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables/score" && method === "PATCH") {
        savedVariable = { ...savedVariable, description: "Draft description" };
        return Promise.resolve(jsonResponse({ variable: savedVariable, usages: [] }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables/score/value" && method === "POST") {
        savedVariable = { ...savedVariable, value: 1600 };
        return Promise.resolve(jsonResponse({ variable: savedVariable }));
      }
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Beschreibung" }), { target: { value: "Draft description" } });
    fireEvent.click(screen.getByRole("button", { name: "Wert bearbeiten" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Wert" }), { target: { value: "1600" } });
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();

    fireEvent.click(screen.getByRole("row", { name: /other/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Speichern und wechseln" }));

    await screen.findByRole("heading", { name: /other/u });
    expect(requests.find(({ method, path }) => method === "PATCH" && path.endsWith("/variables/score"))?.body)
      .toBe(JSON.stringify({ newName: "score", description: "Draft description", resetOnStreamStart: true }));
    expect(requests.find(({ method, path }) => method === "POST" && path.endsWith("/variables/score/value"))?.body)
      .toBe(JSON.stringify({ operation: "set", amount: 1600 }));
  });

  it("does not write an untouched value when a live counter update lands during a metadata save", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    let currentVariable = variable;
    let resolveDefinitionUpdate: ((response: Response) => void) | undefined;
    const definitionUpdate = new Promise<Response>((resolve) => { resolveDefinitionUpdate = resolve; });
    let definitionUpdateStarted = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method });
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables" && method === "GET") {
        return Promise.resolve(jsonResponse({ variables: [currentVariable], count: 1, maximum: 25 }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables/score" && method === "PATCH") {
        definitionUpdateStarted = true;
        return definitionUpdate;
      }
      if (url.pathname === "/api/channels/kanal-a/variables/score/value" && method === "POST") {
        return Promise.resolve(jsonResponse({ variable: { ...currentVariable, value: 10 } }));
      }
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);

    const rendered = render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Beschreibung" }), { target: { value: "Updated description" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => { expect(definitionUpdateStarted).toBe(true); });

    currentVariable = { ...currentVariable, value: 1235, updatedAt: "2026-10-18T12:01:00.000Z" };
    act(() => {
      rendered.queryClient.setQueryData<PanelChannelVariablesResponse>(dashboardDataKeys.variables("kanal-a"), (current) => current === undefined
        ? current
        : { ...current, variables: current.variables.map((entry) => entry.name === "score" ? currentVariable : entry) });
    });
    await waitFor(() => { expect(screen.getByRole("row", { name: /score/u })).toHaveTextContent("1.235"); });
    currentVariable = { ...currentVariable, description: "Updated description" };
    await act(async () => {
      resolveDefinitionUpdate?.(jsonResponse({ variable: { ...currentVariable, description: "Updated description" }, usages: [] }));
      await definitionUpdate;
    });
    await waitFor(() => { expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled(); });

    expect(requests.filter(({ path, method }) => method === "POST" && path.endsWith("/variables/score/value"))).toHaveLength(0);
    expect(screen.getByRole("row", { name: /score/u })).toHaveTextContent("1.235");
  });

  it("discards staged inline and step value edits without sending a value mutation", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method });
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.click(screen.getByRole("button", { name: "Wert bearbeiten" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Wert" }), { target: { value: "1600" } });
    fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));

    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Wert bearbeiten" })).toBeVisible();
    expect(requests.some(({ path, method }) => method === "POST" && path.endsWith("/variables/score/value"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "+1" }));
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    expect(requests.some(({ path, method }) => method === "POST" && path.endsWith("/variables/score/value"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(requests.some(({ path, method }) => method === "POST" && path.endsWith("/variables/score/value"))).toBe(false);
  });

  it("shows a spaced table and lets operators change values while management actions stay locked", async () => {
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
    expect(document.querySelector(".list-toolbar__usage")).toHaveTextContent(/1\s*von\s*25\s*Variablen belegt/u);

    const row = table.querySelector("tbody tr");
    if (row === null) throw new Error("Channel variable row is missing.");
    fireEvent.click(row);

    const editor = document.querySelector(".channel-variable-editor");
    if (!(editor instanceof HTMLElement)) throw new Error("Variable editor is missing.");
    const controls = within(editor);
    expect(controls.queryByRole("switch", { name: "Bei Streamstart auf null setzen" })).not.toBeInTheDocument();
    expect(controls.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(editor.querySelector(".channel-variable-definition-properties")).toHaveTextContent("score");
    expect(editor.querySelector(".channel-variable-definition-properties")).toHaveTextContent("Current score");
    expect(editor.querySelector(".channel-variable-definition-properties")).toHaveTextContent("Ja");
    const permissionNotes = within(editor).queryAllByText(/Nur Broadcaster und Verwalter dürfen Variablen/u);
    expect(permissionNotes).toHaveLength(1);
    expect(permissionNotes[0]).toHaveTextContent(/Nur Broadcaster und Verwalter dürfen Variablen/u);
    expect(editor.querySelectorAll(".ui-locked-reason")).toHaveLength(0);
    const increase = await controls.findByRole("button", { name: "+1" });
    const decrease = controls.getByRole("button", { name: "−1" });
    const editValue = controls.getByRole("button", { name: "Wert bearbeiten" });
    expect(increase).toBeEnabled();
    expect(decrease).toBeEnabled();
    expect(editValue).toBeEnabled();
    expect(controls.queryByText("Nur Broadcaster und Verwalter dürfen Variablenwerte ändern.")).not.toBeInTheDocument();
    expect(controls.queryByRole("spinbutton", { name: "Setzen auf" })).not.toBeInTheDocument();
    expect(controls.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(screen.queryByText("Overlay-Link")).not.toBeInTheDocument();
  });

  it("keeps a dirty definition draft visible and guarded after a remote removal", async () => {
    let currentVariables = [variable];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/overlay-tokens")) return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.resolve(jsonResponse({ variables: currentVariables, count: currentVariables.length, maximum: 25 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const rendered = render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Beschreibung" }), { target: { value: "Local draft" } });
    currentVariables = [];
    await act(async () => {
      await rendered.queryClient.invalidateQueries({ queryKey: dashboardDataKeys.variables("kanal-a"), exact: true });
    });
    await screen.findByText(/umbenannt oder gelöscht/u);

    const editor = document.querySelector(".channel-variable-editor");
    expect(editor).toBeInTheDocument();
    expect(within(editor as HTMLElement).getByRole("textbox", { name: "Beschreibung" })).toHaveValue("Local draft");
    expect(editor).toHaveTextContent("Diese Variable wurde inzwischen umbenannt oder gelöscht.");
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    fireEvent.click(within(editor as HTMLElement).getByRole("button", { name: "Verwerfen" }));
    expect(document.querySelector(".channel-variable-editor")).not.toBeInTheDocument();
  });

  it("shows only one management permission reason when an operator's selected variable is removed remotely", async () => {
    let currentVariables = [variable];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/overlay-tokens")) return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.resolve(jsonResponse({ variables: currentVariables, count: currentVariables.length, maximum: 25 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const rendered = render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage={false} onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    const editor = document.querySelector(".channel-variable-editor");
    if (!(editor instanceof HTMLElement)) throw new Error("Variable editor is missing.");

    currentVariables = [];
    await act(async () => {
      await rendered.queryClient.invalidateQueries({ queryKey: dashboardDataKeys.variables("kanal-a"), exact: true });
    });
    await screen.findByText(/umbenannt oder gelöscht/u);

    expect(document.querySelector(".channel-variables-permission-note")).toBeNull();
    expect(within(editor).queryAllByText(/Nur Broadcaster und Verwalter dürfen Variablen/u)).toHaveLength(1);
  });

  it("stages inline and one-step value edits for Save and cancels inline edits on Escape", async () => {
    let currentValue = variable.value;
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables/score/value" && method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { operation: "add" | "subtract" | "set"; amount: number } : null;
        if (body === null) return Promise.resolve(jsonResponse({ error: "missing_body" }, 400));
        currentValue = body.operation === "add" ? currentValue + body.amount : body.operation === "subtract" ? currentValue - body.amount : body.amount;
        return Promise.resolve(jsonResponse({ variable: { ...variable, value: currentValue } }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [{ ...variable, value: currentValue }], count: 1, maximum: 25 }));
      if (url.pathname.endsWith("/overlay-tokens")) return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.click(screen.getByRole("button", { name: "Wert bearbeiten" }));
    const input = screen.getByRole("spinbutton", { name: "Wert" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "456" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Wert bearbeiten" }));
    expect(screen.queryByRole("spinbutton", { name: "Wert" })).not.toBeInTheDocument();
    expect(document.querySelector(".channel-variable-value-controls__value")).toHaveTextContent("1.234");

    fireEvent.click(screen.getByRole("button", { name: "Wert bearbeiten" }));
    const reopenedInput = screen.getByRole("spinbutton", { name: "Wert" });
    fireEvent.change(reopenedInput, { target: { value: "456" } });
    fireEvent.keyDown(reopenedInput, { key: "Enter" });
    expect(currentValue).toBe(1234);
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    expect(requests.some(({ method, body }) => method === "POST" && body?.includes('"operation":"set"'))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(currentValue).toBe(456));
    expect(requests.find(({ method, body }) => method === "POST" && body?.includes('"operation":"set"'))?.body).toBe(JSON.stringify({ operation: "set", amount: 456 }));
    await waitFor(() => expect(document.querySelector(".channel-variable-value-controls__value")).toHaveTextContent("456"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Wert bearbeiten" }));

    fireEvent.click(screen.getByRole("button", { name: "+1" }));
    expect(currentValue).toBe(456);
    expect(document.querySelector(".channel-variable-value-controls__value")).toHaveTextContent("457");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    expect(requests.some(({ method, body }) => method === "POST" && body?.includes('"amount":457'))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(currentValue).toBe(457));
    expect(requests.some(({ method, body }) => method === "POST" && body === JSON.stringify({ operation: "set", amount: 457 }))).toBe(true);
  });

  it("keeps a saved variable value when the follow-up read fails", async () => {
    setBrowserLanguage("en-US");
    let currentValue = variable.value;
    let variableReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables/score/value" && method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { operation: "add" | "subtract" | "set"; amount: number } : null;
        if (body === null) return Promise.resolve(jsonResponse({ error: "missing_body" }, 400));
        currentValue = body.operation === "add" ? currentValue + body.amount : body.operation === "subtract" ? currentValue - body.amount : body.amount;
        return Promise.resolve(jsonResponse({ variable: { ...variable, value: currentValue } }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables") {
        variableReads += 1;
        return variableReads === 1
          ? Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }))
          : Promise.reject(new Error("variables revalidation failed"));
      }
      if (url.pathname.endsWith("/overlay-tokens")) return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);

    const view = render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.click(screen.getByRole("button", { name: "+1" }));
    expect(currentValue).toBe(1234);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(currentValue).toBe(1235));
    await waitFor(() => expect(view.queryClient.getQueryData<{ variables: Array<{ value: number }> }>(["channel", "kanal-a", "variables"])?.variables[0]?.value).toBe(1235));
    await waitFor(() => expect(variableReads).toBe(2));
    expect(document.querySelector(".channel-variable-value-controls__value")).toHaveTextContent("1,235");
    const newToasts = toastsSnapshot().filter((toast) => toast.message === "The channel variable could not be saved.");
    expect(newToasts).toHaveLength(0);
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

  it("uses the renamed variable when saving before opening the overlay editor", async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    let savedVariable = variable;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables/score" && method === "PATCH") {
        savedVariable = { ...variable, name: "wins" };
        return Promise.resolve(jsonResponse({ variable: savedVariable, usages: [] }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [savedVariable], count: 1, maximum: 25 }));
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
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "wins" } });
    fireEvent.click(screen.getByRole("button", { name: "In Overlay verwenden" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editor öffnen" }));
    fireEvent.click(await screen.findByRole("button", { name: "Speichern und wechseln" }));

    await waitFor(() => expect(onOpenOverlay).toHaveBeenCalledWith("overlay-a", "wins"));
    expect(requests.find(({ method }) => method === "PATCH")?.body).toBe(JSON.stringify({ newName: "wins", description: "Current score", resetOnStreamStart: true }));
  });

  it("shows text command usages with one leading bang", async () => {
    const usedVariable = { ...variable, usages: [{ moduleId: "text_commands", itemName: "!score", kind: "template" as const }] };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse({ variables: [usedVariable], count: 1, maximum: 25 }))));
    const onOpenCommand = vi.fn();
    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={onOpenCommand} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));

    const usage = await screen.findByRole("button", { name: "!score" });
    expect(usage).not.toHaveTextContent("!!score");
    const usageRow = usage.closest(".channel-variable-usage-row");
    expect(usageRow).toHaveTextContent("Vorlage");
    expect(usageRow).toHaveTextContent("Textbefehle");
    fireEvent.click(usage);
    expect(onOpenCommand).toHaveBeenCalledWith("score");
  });

  it("keeps a new overlay local until its editor is saved", async () => {
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

    expect(onOpenOverlay).toHaveBeenCalledWith("new", "score", "Overlay score");
    expect(requests.some(({ path, method }) => path.endsWith("/overlays") && method === "POST")).toBe(false);
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
    expect(within(document.querySelector(".channel-variable-editor") as HTMLElement).queryAllByText(/Nur Broadcaster und Verwalter dürfen Variablen/u)).toHaveLength(1);
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
    render(<UiProvider><ToastHost /><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
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

  it("revalidates variables from the shared query after a realtime hint", async () => {
    let variableRequestCount = 0;
    const revisions = { "channel.variables": 1 };
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname.endsWith("/revisions")) return Promise.resolve(jsonResponse({ revisions }));
      if (url.pathname.endsWith("/overlay-tokens")) return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      variableRequestCount++;
      return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const rendered = render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    await screen.findByRole("table");
    expect(variableRequestCount).toBe(1);

    await reconcileDashboardRealtimeMessage(rendered.queryClient, {
      version: 1,
      id: "variables-changed-1",
      createdAt: "2026-09-24T12:00:00.000Z",
      channelId: "kanal-a",
      type: "variables.changed",
      payload: { set: [{ name: "score", value: 1235 }], removed: [] },
    } satisfies RealtimeMessage);

    await waitFor(() => { expect(variableRequestCount).toBe(2); });
    expect(screen.getByRole("row", { name: /score/i })).toBeInTheDocument();
  });

  it("consumes each command palette selection, applies later requests on the mounted page, and does not replay one after returning", async () => {
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
    expect(document.querySelector(".channel-variable-definition-properties")).toHaveTextContent("score");

    fireEvent.click(screen.getByRole("button", { name: "Request other variable" }));
    expect(await screen.findByText("other", { selector: ".channel-variable-definition-properties dd" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Leave variables" }));
    fireEvent.click(screen.getByRole("button", { name: "Return to variables" }));
    await screen.findByRole("table");
    expect(document.querySelector(".channel-variable-definition-properties")).not.toBeInTheDocument();
  });
});
