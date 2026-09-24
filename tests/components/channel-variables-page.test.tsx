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

  it.each([
    ["de-DE", "In OBS einrichten", "Füge in OBS eine Browserquelle hinzu", "Geheimnis", "jederzeit auf der Seite Overlay-Links widerrufen", "Diagnoseinformationen", "Benutzerdefiniertes CSS"],
    ["en-US", "Set up in OBS", "Add a Browser Source in OBS", "contains a secret", "revoke it at any time on the Overlay links page", "show diagnostics", "Custom CSS"],
  ])("shows the localized OBS guide in the variable overlay section (%s)", async (language, summary, sourceStep, secret, revoke, diagnostics, customCss) => {
    setBrowserLanguage(language);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));

    const disclosure = await screen.findByText(summary);
    fireEvent.click(disclosure);
    const guide = disclosure.closest("details");
    expect(guide).not.toBeNull();
    expect(guide).toHaveTextContent(sourceStep);
    expect(guide).toHaveTextContent("800 × 120 px");
    expect(guide).toHaveTextContent(secret);
    expect(guide).toHaveTextContent(revoke);
    expect(guide).toHaveTextContent(diagnostics);
    expect(guide).toHaveTextContent("&debug=1");
    expect(guide).toHaveTextContent(customCss);
    expect(guide).toHaveTextContent("font: 700 48px system-ui, sans-serif");
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
    expect(within(resetSwitch.closest(".ui-switch-card") as HTMLElement).getByText("Wird zurückgesetzt, wenn der nächste Stream startet.")).toBeInTheDocument();
    expect(await controls.findByRole("button", { name: "+1" })).toBeInTheDocument();
    expect(controls.getByRole("button", { name: "−1" })).toBeInTheDocument();
    expect(controls.getByRole("spinbutton", { name: "Setzen auf" })).toBeInTheDocument();
    expect(controls.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(controls.getByRole("button", { name: "Speichern" })).toHaveAttribute("title", expect.stringContaining("Nur Broadcaster"));
    expect(screen.queryByText("Overlay-Link")).not.toBeInTheDocument();
  });

  it("issues a token and builds a copyable overlay URL and OBS CSS for managers", async () => {
    const issuedUrl = `https://brobot.example/overlay#token=${"s".repeat(43)}`;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/csrf")) return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.endsWith("/api/channels/kanal-a/variables")) {
        return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      }
      if (url.endsWith("/api/channels/kanal-a/overlay-tokens") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ tokenId: "token-1", overlayUrl: issuedUrl, expiresAt: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    const row = await screen.findByRole("row", { name: /score/i });
    fireEvent.click(row);

    expect(await screen.findByText("Overlay-Link")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Anzeige"), { target: { value: "Punkte {value}" } });
    fireEvent.click(screen.getByRole("button", { name: "Link erzeugen" }));

    const overlayUrl = await screen.findByLabelText("Widget-URL");
    expect(overlayUrl).toHaveValue(`http://localhost:3000/overlay#token=${"s".repeat(43)}&var=score&text=Punkte+%7Bvalue%7D`);
    expect(fetcher.mock.calls.some(([input, init]) => {
      const requestUrl = typeof input === "string" ? new URL(input, window.location.href)
        : input instanceof URL ? input : new URL(input.url);
      return requestUrl.pathname === "/api/channels/kanal-a/overlay-tokens" && init?.method === "POST";
    })).toBe(true);
    expect(screen.getByLabelText("OBS CSS")).toHaveValue(`.brobot-variable {
  font: 700 48px system-ui, sans-serif;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .9);
}`);
    expect(screen.getByText(/Geheim: Wer den Link hat/i)).toBeInTheDocument();
  });

  it("reuses a pasted overlay token in the browser without issuing another token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));
    fireEvent.change(screen.getByLabelText("Vorhandenen Overlay-Link einfügen"), {
      target: { value: `https://brobot.example/overlay#token=${"e".repeat(43)}` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link übernehmen" }));

    expect(await screen.findByLabelText("Widget-URL")).toHaveValue(`http://localhost:3000/overlay#token=${"e".repeat(43)}&var=score&text=score%3A+%7Bvalue%7D`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps variable actions before a separated overlay section and a visible disabled import button", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    fireEvent.click(await screen.findByRole("row", { name: /score/i }));

    const inspector = document.querySelector(".list-detail__inspector");
    if (!(inspector instanceof HTMLElement)) throw new Error("Variable inspector is missing.");
    const controls = within(inspector);
    const precedes = (first: Node, second: Node): boolean =>
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const variableName = controls.getByLabelText("Name");
    const valueControls = inspector.querySelector(".channel-variable-value-controls");
    const usages = controls.getByRole("heading", { name: "Verwendet in" });
    const actions = inspector.querySelector(".channel-variable-editor__actions");
    const overlaySection = controls.getByRole("region", { name: "Overlay-Link" });
    const divider = within(overlaySection).getByRole("separator");
    const deleteButton = controls.getByRole("button", { name: "Variable löschen" });
    const useExistingButton = controls.getByRole("button", { name: "Link übernehmen" });

    if (valueControls === null || actions === null) throw new Error("Variable controls are missing.");
    expect(precedes(variableName, valueControls)).toBe(true);
    expect(precedes(valueControls, usages)).toBe(true);
    expect(precedes(usages, actions)).toBe(true);
    expect(precedes(actions, overlaySection)).toBe(true);
    expect(precedes(divider, within(overlaySection).getByRole("heading", { name: "Overlay-Link" }))).toBe(true);
    expect(precedes(overlaySection, deleteButton)).toBe(true);
    expect(inspector.querySelector(".channel-variable-editor")?.lastElementChild).toBe(deleteButton);
    expect(useExistingButton).toBeDisabled();
    expect(useExistingButton.style.opacity).toBe("0.7");
  });

  it("coalesces variable hints, bounds continuous refreshes, and keeps one request in flight", async () => {
    let releaseThird: ((result: Response) => void) | null = null;
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockImplementation(() => fetcher.mock.calls.length === 3
      ? new Promise((resolve) => { releaseThird = resolve; })
      : Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 })));
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
    expect(fetcher).toHaveBeenCalledTimes(2);

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
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(3);

    for (let index = 10; index < 25; index++) {
      sendHint(index);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(releaseThird).toBeTypeOf("function");
    await act(async () => {
      releaseThird?.(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    fireEvent.focus(window);
    expect(fetcher).toHaveBeenCalledTimes(4);
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
