import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelVariablesPage } from "../../src/dashboard/ChannelVariablesPage";
import { UiProvider } from "../../src/dashboard/ui";

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

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

class DashboardSocket {
  public static instances: DashboardSocket[] = [];
  public readonly listeners = new Map<string, Set<EventListener>>();
  public protocol = "brobot.v1";

  public constructor(public readonly url: string, public readonly protocols?: string | string[]) {
    DashboardSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(typeof listener === "function" ? listener : (event) => listener.handleEvent(event));
    this.listeners.set(type, listeners);
  }

  public close(code = 1000): void {
    this.dispatch("close", { code, reason: "closed" } as CloseEvent);
  }

  public dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("Channel variables page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    DashboardSocket.instances = [];
  });

  it("shows a spaced table, reset indicator, quick controls, and disabled Save for operators", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(response({
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
      if (url.endsWith("/api/csrf")) return Promise.resolve(response({ token: "csrf-token" }));
      if (url.endsWith("/api/channels/kanal-a/variables")) {
        return Promise.resolve(response({ variables: [variable], count: 1, maximum: 25 }));
      }
      if (url.endsWith("/api/channels/kanal-a/overlay-tokens") && init?.method === "POST") {
        return Promise.resolve(response({ tokenId: "token-1", overlayUrl: issuedUrl, expiresAt: null }));
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
    expect(screen.getByText(/Geheim/i)).toBeInTheDocument();
  });

  it("reuses a pasted overlay token in the browser without issuing another token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ variables: [variable], count: 1, maximum: 25 }));
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

  it("refreshes from variables.changed and no longer reloads on window focus", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ variables: [variable], count: 1, maximum: 25 }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", DashboardSocket);

    render(<UiProvider><ChannelVariablesPage channelId="kanal-a" canManage onOpenCommand={() => {}} /></UiProvider>);
    await screen.findByRole("table");
    expect(DashboardSocket.instances).toHaveLength(1);
    DashboardSocket.instances[0]?.dispatch("open", new Event("open"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    DashboardSocket.instances[0]?.dispatch("message", {
      data: JSON.stringify({
        version: 1,
        id: "variables-changed-1",
        createdAt: "2026-09-24T12:00:00.000Z",
        channelId: "kanal-a",
        type: "variables.changed",
        payload: { set: [{ name: "score", value: 1235 }], removed: [] },
      }),
    } as MessageEvent<string>);

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    fireEvent.focus(window);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
