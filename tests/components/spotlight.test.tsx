import type { ReactElement } from "react";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { Spotlight } from "../../src/dashboard/ui/Spotlight";
import { ChannelSpotlight } from "../../src/dashboard/spotlight";
import { ModuleIcon } from "../../src/dashboard/module-panels";
import { jsonResponse } from "../unit/fixtures";

const renderWithMantine = (element: ReactElement): ReturnType<typeof render> => render(<UiProvider>{element}</UiProvider>);

const requestUrl = (input: RequestInfo | URL): URL =>
  input instanceof Request ? new URL(input.url) : new URL(String(input), window.location.origin);

const stubFetch = (): ReturnType<typeof vi.fn<typeof fetch>> => {
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const path = requestUrl(input).pathname;
    if (path === "/api/channels/kanal-a/modules/text_commands/commands") {
      return Promise.resolve(jsonResponse({ commands: [{ channelId: "kanal-a", name: "clip", text: "Clip!", kind: "text", enabled: true, minimumTier: "everyone", cooldownSeconds: 5, lastUsedAt: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z" }] }));
    }
    if (path === "/api/channels/kanal-a/variables") {
      return Promise.resolve(jsonResponse({
        variables: [{ channelId: "kanal-a", name: "counter", value: 5, description: "", resetOnStreamStart: false, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", usages: [] }],
        count: 1,
        maximum: 20,
      }));
    }
    if (path === "/api/channels/kanal-a/members") {
      return Promise.resolve(jsonResponse({ members: [{ userId: "user-1", login: "max", displayName: "Max", profileImageUrl: null, role: "operator", joinedAt: "2026-09-19T00:00:00.000Z" }], broadcasterCount: 1, viewerUserId: "user-1", nextCursor: null }));
    }
    if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
    if (init?.method === "PATCH" || init?.method === "POST") return Promise.resolve(jsonResponse({}));
    return Promise.resolve(jsonResponse({}, 404));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

describe("Channel Spotlight", () => {
  afterEach(() => {
    // Mantine's Spotlight keeps its open/closed state in a store shared by
    // every instance (no `id` prop distinguishes them here) -- closing
    // explicitly before unmount stops a test that leaves it open from
    // starting the next one already "opened" with no open transition to
    // fire `onSpotlightOpen`, silently skipping that test's lazy fetch.
    fireEvent.keyDown(document.body, { key: "Escape" });
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens with the mod+K shortcut and finds a module by name", async () => {
    stubFetch();
    const onNavigate = vi.fn();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={onNavigate} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "raid" } });
    const action = await screen.findByText("Shoutout");
    fireEvent.click(action);

    expect(onNavigate).toHaveBeenCalledWith({ kind: "module", channelId: "kanal-a", moduleId: "raid" });
  });

  it("shows registered action and entity groups in order when opened", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" streamState="online" modules={[{ id: "clips", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    await screen.findByText("!clip");
    await screen.findByText("{var.counter}");

    const dialog = screen.getByRole("dialog");
    const groupLabels = ["Aktionen", "Betrieb", "Kanal", "Module", "Befehle", "Variablen"].map((label) => `'${label}'`);
    await waitFor(() => {
      expect(Array.from(dialog.querySelectorAll<HTMLElement>(".mantine-Spotlight-actionsGroup"))
        .map((group) => group.style.getPropertyValue("--spotlight-label"))).toEqual(groupLabels);
    });
    expect(screen.getByText("Clip erstellen")).toBeInTheDocument();
    const clipAction = screen.getByText("Clip erstellen").closest(".mantine-Spotlight-action");
    expect(clipAction).not.toBeNull();
    expect(clipAction?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(clipAction).toHaveAccessibleName("Clip erstellen");
  });

  it("keeps hand-drawn module glyphs outlined for ads actions", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[{ id: "ads", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ads off" } });
    const adsAction = (await screen.findByText("Werbung aus")).closest(".mantine-Spotlight-action");
    const adsGlyph = adsAction?.querySelector("svg.spotlight-module-icon");
    expect(adsGlyph).toHaveClass("module-glyph");
    expect(adsGlyph).toHaveAttribute("aria-hidden", "true");

    expect(adsAction?.querySelector(".mantine-Spotlight-action-icon-dot")).toBeNull();
  });

  it("renders a text-command result with the shared hand-drawn module icon family", () => {
    renderWithMantine(<Spotlight
      forceOpened
      emptyMessage="No results."
      items={[{ id: "command:clip", label: "!clip", group: "Befehle", icon: <ModuleIcon moduleId="text_commands" className="spotlight-module-icon" />, onTrigger: vi.fn() }]}
    />);
    const commandAction = screen.getByText("!clip").closest(".mantine-Spotlight-action");
    const commandGlyph = commandAction?.querySelector("svg.spotlight-module-icon");
    expect(commandGlyph).toHaveClass("module-glyph");
    expect(commandGlyph).toHaveAttribute("aria-hidden", "true");
    expect(commandAction?.querySelector(".mantine-Spotlight-action-icon-dot")).toBeNull();
  });

  it("explains that mandatory channel events remain active from Spotlight", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "kanalereignisse" } });

    expect(await screen.findByText("Kanalereignisse")).toBeInTheDocument();
    expect(screen.getByText(/Kanalereignisse sind immer aktiv\./)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => { expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); });
  });

  it("finds a text command by its bang name and opens it in the editor", async () => {
    stubFetch();
    const onNavigate = vi.fn();
    const onOpenCommand = vi.fn();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={onNavigate} onOpenCommand={onOpenCommand} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "!clip" } });

    const action = await screen.findByText("!clip");
    fireEvent.click(action);

    expect(onOpenCommand).toHaveBeenCalledWith("clip");
    expect(onNavigate).toHaveBeenCalledWith({ kind: "module", channelId: "kanal-a", moduleId: "text_commands" });
  });

  it("no longer offers a member as a search result (#208)", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "max" } });

    await waitFor(() => { expect(screen.getByText("Keine Treffer.")).toBeInTheDocument(); });
    expect(screen.queryByText("Max")).not.toBeInTheDocument();
  });

  const findsPageByQuery = async (query: string, pageLabel: string): Promise<void> => {
    stubFetch();
    const onNavigate = vi.fn();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={onNavigate} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: query } });

    const action = await screen.findByText(pageLabel);
    fireEvent.click(action);

    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ kind: "channel", channelId: "kanal-a" }));
  };

  it('finds the events page by typing "ereig" (#208)', async () => { await findsPageByQuery("ereig", "Ereignisse"); });
  it('finds the events page by its "log" synonym (#208)', async () => { await findsPageByQuery("log", "Ereignisse"); });
  it('finds the audit log page by typing "audit" (#208)', async () => { await findsPageByQuery("audit", "Audit-Log"); });
  it('finds the variables page by typing "variab" (#208)', async () => { await findsPageByQuery("variab", "Variablen"); });

  it("disables pages the router blocks while the installation bot is signed out", async () => {
    stubFetch();
    const onNavigate = vi.fn();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" botSignedIn={false} modules={[]} onNavigate={onNavigate} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");

    for (const label of ["Ereignisse", "Mitglieder"]) {
      const action = (await screen.findByText(label)).closest(".mantine-Spotlight-action");
      expect(action).toBeDisabled();
      expect(action).toHaveTextContent("Der Bot ist nicht angemeldet");
    }
    const variables = (await screen.findByText("Variablen")).closest(".mantine-Spotlight-action");
    expect(variables).not.toBeDisabled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("hides the operator-only platform page for a non-operator (#208)", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "betreiber" } });
    await waitFor(() => { expect(screen.getByText("Keine Treffer.")).toBeInTheDocument(); });
  });

  it("shows the platform page for a platform admin (#208)", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" isPlatformAdmin modules={[]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "betreiber" } });
    expect(await screen.findByText("Betreiber")).toBeInTheDocument();
  });

  it("navigates to the variables page and selects the variable (#208)", async () => {
    stubFetch();
    const onNavigate = vi.fn();
    const onOpenVariable = vi.fn();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={onNavigate} onOpenCommand={vi.fn()} onOpenVariable={onOpenVariable} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "counter" } });

    const action = await screen.findByText("{var.counter}");
    fireEvent.click(action);

    expect(onOpenVariable).toHaveBeenCalledWith("counter");
    expect(onNavigate).toHaveBeenCalledWith({ kind: "channel", channelId: "kanal-a", section: "variables" });
  });

  it("runs the ads-off registered action for a manager", async () => {
    const fetcher = stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" modules={[{ id: "ads", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ads off" } });
    fireEvent.click(await screen.findByText("Werbung aus"));

    await vi.waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) =>
        requestUrl(input).pathname === "/api/channels/kanal-a/modules/ads" && init?.method === "PATCH")).toBe(true);
    });
  });

  it("disables the ads-off action for an operator, with the management-locked reason", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="operator" modules={[{ id: "ads", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ads off" } });

    const adsOffAction = (await screen.findByText("Werbung aus")).closest(".mantine-Spotlight-action");
    expect(adsOffAction).not.toBeNull();
    expect(adsOffAction?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(adsOffAction).toHaveTextContent("Nur Broadcaster und Verwalter dürfen Module ändern.");
  });

  it("runs the parametrized shoutout action with the typed login", async () => {
    const fetcher = stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="operator" streamState="online" modules={[{ id: "raid", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "shoutout streamerin" } });
    fireEvent.click(await screen.findByText("Shoutout senden"));

    await vi.waitFor(() => {
      const call = fetcher.mock.calls.find(([input, init]) =>
        requestUrl(input).pathname === "/api/channels/kanal-a/shoutout" && init?.method === "POST");
      expect(call).toBeDefined();
      const body = call?.[1]?.body;
      expect(JSON.parse(typeof body === "string" ? body : "{}") as unknown).toEqual({ login: "streamerin" });
    });
  });

  it("hides ad-now, clip, and shoutout when their modules are disabled (#178)", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" streamState="online" modules={[]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");

    expect(screen.queryByText("Werbung jetzt (60s)")).not.toBeInTheDocument();
    expect(screen.queryByText("Clip erstellen")).not.toBeInTheDocument();
    expect(screen.queryByText("Shoutout senden")).not.toBeInTheDocument();
  });

  it("disables the clip action while the stream is offline, with the module's own reason (#178)", async () => {
    stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="manager" streamState="offline" modules={[{ id: "clips", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");

    const clipAction = (await screen.findByText("Clip erstellen")).closest(".mantine-Spotlight-action");
    expect(clipAction).toHaveTextContent("Der Stream ist offline.");
  });

  it("lets an operator run ad-now while live -- the endpoint has no role check (#178)", async () => {
    const fetcher = stubFetch();
    renderWithMantine(<ChannelSpotlight channelId="kanal-a" ownRole="operator" streamState="online" modules={[{ id: "ads", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");

    const adNowAction = (await screen.findByText("Werbung jetzt (60s)")).closest(".mantine-Spotlight-action");
    expect(adNowAction).not.toHaveTextContent("Nur Broadcaster und Verwalter dürfen Module ändern.");
    fireEvent.click(await screen.findByText("Werbung jetzt (60s)"));

    await vi.waitFor(() => {
      const call = fetcher.mock.calls.find(([input, init]) =>
        requestUrl(input).pathname === "/api/channels/kanal-a/modules/ads/commercial" && init?.method === "POST");
      expect(call).toBeDefined();
      const body = call?.[1]?.body;
      expect(JSON.parse(typeof body === "string" ? body : "{}") as unknown).toEqual({ length: 60 });
    });
  });
});
