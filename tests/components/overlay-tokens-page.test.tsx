import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayTokensPage } from "../../src/dashboard/OverlayTokensPage";
import { UiProvider } from "../../src/dashboard/ui";

const token = {
  id: "token-123",
  name: null,
  createdAt: "2026-09-24T10:00:00.000Z",
  createdBy: "Sample Creator",
  lastUsedAt: null,
  expiresAt: null,
};

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

const setBrowserLanguage = (language: string): void => {
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
};

describe("Overlay tokens page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setBrowserLanguage("de-DE");
  });

  it.each([
    ["de-DE", "In OBS einrichten", "Füge in OBS eine Browserquelle hinzu", "Geheimnis", "jederzeit auf der Seite Overlay-Links widerrufen", "Diagnoseinformationen", "Benutzerdefiniertes CSS"],
    ["en-US", "Set up in OBS", "Add a Browser Source in OBS", "contains a secret", "revoke it at any time on the Overlay links page", "show diagnostics", "Custom CSS"],
  ])("shows the localized OBS guide on the overlay links page (%s)", async (language, summary, sourceStep, secret, revoke, diagnostics, customCss) => {
    setBrowserLanguage(language);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response({ tokens: [] })));

    render(<UiProvider><OverlayTokensPage channelId="kanal-a" canManage /></UiProvider>);

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

  it("lists tokens, shows metadata, and leaves disabled management controls visible for operators", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ tokens: [token] }));
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><OverlayTokensPage channelId="kanal-a" canManage={false} /></UiProvider>);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("token-123")).toBeInTheDocument();
    expect(table.querySelectorAll("thead th")).toHaveLength(6);
    expect(table.querySelector("thead th:last-child .sr-only")).toHaveTextContent("Link widerrufen");
    fireEvent.click(table.querySelector("tbody tr") as HTMLTableRowElement);
    expect(table.closest(".list-detail")).toHaveClass("list-detail--open");
    expect(table.closest(".overlay-tokens-table-wrap")).toHaveClass("overlay-tokens-table-wrap--inspector-open");

    const inspector = document.querySelector(".list-detail__inspector");
    if (!(inspector instanceof HTMLElement)) throw new Error("Overlay token inspector is missing.");
    expect(within(inspector).getByText("Sample Creator")).toBeInTheDocument();
    expect(within(inspector).getByText("Ausgestellt am")).toBeInTheDocument();
    expect(within(inspector).getByText("Zuletzt verwendet").parentElement).toHaveTextContent("Nie");
    expect(within(inspector).getByRole("button", { name: "Link widerrufen" })).toBeDisabled();
    expect(within(inspector).getByRole("button", { name: "Link widerrufen" })).toHaveAttribute("title", expect.stringContaining("Nur Broadcaster"));
    expect(within(table).getByText("Sample Creator")).toBeInTheDocument();
    expect(within(table).getByText("Läuft ab")).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "Link widerrufen" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Overlay-Link ausstellen" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Overlay-Link ausstellen" })).toHaveAttribute("title", expect.stringContaining("Nur Broadcaster"));
    expect(within(inspector).getByText(/Nur Broadcaster/)).toBeInTheDocument();
  });

  it("shows a newly issued full link once, copies it, and hides it after closing the inspector", async () => {
    const link = "https://brobot.example/overlay#token=one-time-secret";
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ tokens: [] }))
      .mockResolvedValueOnce(response({ token: "csrf" }))
      .mockResolvedValueOnce(response({ tokenId: "new-token", overlayUrl: link, expiresAt: null }))
      .mockResolvedValueOnce(response({ tokens: [{ ...token, id: "new-token", createdBy: null }] }));
    vi.stubGlobal("fetch", fetcher);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<UiProvider><OverlayTokensPage channelId="kanal-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Overlay-Link ausstellen" }));

    expect(await screen.findByText(link)).toBeInTheDocument();
    expect(screen.getByText(/wird nur jetzt angezeigt/)).toBeInTheDocument();
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByText("new-token"));
    expect(screen.getByText(link)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link kopieren" }));
    expect(writeText).toHaveBeenCalledWith(link);
    expect(await screen.findByRole("button", { name: "Kopiert" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByText(link)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText("new-token"));
    expect(screen.queryByText(link)).not.toBeInTheDocument();
  });

  it("asks before revoking a token and refreshes the list", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ tokens: [token] }))
      .mockResolvedValueOnce(response({ token: "csrf" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ tokens: [] }));
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><OverlayTokensPage channelId="kanal-a" canManage /></UiProvider>);
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Link widerrufen" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/wird sofort ungültig/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "token-123 widerrufen" }));

    await screen.findByText("Noch keine Overlay-Links ausgestellt.");
    const revokeRequest = fetcher.mock.calls.find((call) => {
      const input = call[0];
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/revoke");
    });
    expect(revokeRequest?.[1]?.body).toBe(JSON.stringify({ reason: "Widerruf über das Dashboard" }));
    expect(screen.queryByText("token-123")).not.toBeInTheDocument();
  });

  it("reports that connected windows are still closing after a pending revoke", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ tokens: [token], nextOffset: null }))
      .mockResolvedValueOnce(response({ token: "csrf" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ closingPending: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(response({ tokens: [], nextOffset: null }));
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><OverlayTokensPage channelId="kanal-a" canManage /></UiProvider>);
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Link widerrufen" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "token-123 widerrufen" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Verbundene Overlay-Fenster werden noch geschlossen.");
  });

  it("ignores an older list response that arrives after a newer refresh", async () => {
    let resolveInitial!: (result: Response) => void;
    let resolveRefresh!: (result: Response) => void;
    const initial = new Promise<Response>((resolve) => { resolveInitial = resolve; });
    const refresh = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce(refresh);
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><OverlayTokensPage channelId="kanal-a" canManage /></UiProvider>);
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2); });

    resolveRefresh(response({ tokens: [], nextOffset: null }));
    expect(await screen.findByText("Noch keine Overlay-Links ausgestellt.")).toBeInTheDocument();
    resolveInitial(response({ tokens: [token], nextOffset: null }));
    await vi.waitFor(() => { expect(screen.queryByText("token-123")).not.toBeInTheDocument(); });
  });
});
