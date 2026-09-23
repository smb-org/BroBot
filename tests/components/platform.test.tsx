import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";

const response = (inhalt: unknown, status = 200): Response => new Response(JSON.stringify(inhalt), {
  status,
  headers: { "Content-Type": "application/json" },
});

const requestUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input, window.location.origin);
};

const channel = {
  channelId: "123",
  login: "alpha_login",
  displayName: "Alpha",
  fullConsent: true,
  memberCounts: { broadcaster: 1, manager: 1, operator: 0 },
  broadcasterConnected: false,
};

const members = {
  members: [
    { userId: "123", login: "alpha_login", displayName: "Alpha", profileImageUrl: null, role: "broadcaster", joinedAt: "2026-09-19T12:00:00.000Z" },
    { userId: "456", login: "helfer", displayName: "Helfer", profileImageUrl: null, role: "manager", joinedAt: "2026-09-19T13:00:00.000Z" },
  ],
  nextCursor: null,
  broadcasterCount: 1,
  viewerUserId: "999",
};

const setUpPlatform = (
  platform: boolean,
  audit: { entries: unknown[]; nextCursor: string | null } = { entries: [], nextCursor: null },
): ReturnType<typeof vi.fn<typeof fetch>> => {
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/channels") return Promise.resolve(response({ channels: [], bot: { status: "connected", reason: null, updatedAt: "2026-09-18T00:00:00.000Z" }, platformAdmin: platform }));
    if (url.pathname === "/api/platform") return Promise.resolve(response({ channels: [channel] }));
    if (url.pathname === "/api/platform/audit") return Promise.resolve(response(audit));
    if (url.pathname === "/api/platform/channels/123/members") return Promise.resolve(response(members));
    return Promise.resolve(response({}, 404));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("Platform level", () => {
  it("shows neither navigation nor the platform route without platform access", async () => {
    setUpPlatform(false);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Noch kein Kanal freigegeben", level: 2 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("link", { name: "Betreiber" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Betreiberebene", level: 1 })).not.toBeInTheDocument();
  });

  it("never offers Broadcaster in any role selector", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const channelRow = await screen.findByRole("row", { name: /alpha_login/ });
    fireEvent.click(channelRow);
    const rolle = await screen.findByRole("combobox", { name: "Rolle: Helfer" });

    expect(within(rolle).queryByRole("option", { name: "Broadcaster" })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("option", { name: "Broadcaster" })).toHaveLength(0);
  });

  it("keeps the channel table compact with role counts combined and explained", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const channelRow = await screen.findByRole("row", { name: /alpha_login/ });
    const table = channelRow.closest("table");
    if (table === null) throw new Error("Kanalübersicht-Tabelle fehlt");
    expect(table).toHaveClass("platform-channel-table");
    expect(within(table).getByRole("columnheader", { name: "Kennung" })).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
    const membersHeader = within(table).getByRole("columnheader", { name: "Mitglieder" });
    const consentHeader = within(table).getByRole("columnheader", { name: "Zustimmung" });
    const counts = within(channelRow).getByText("1 · 1 · 0");
    expect(consentHeader).toHaveAttribute("title", "Vollzustimmung");
    expect(membersHeader).toHaveAttribute("title", expect.stringContaining("·"));
    expect(counts).toHaveAttribute("title", membersHeader.getAttribute("title"));
  });

  it("hides the channel id and uses the UI Select for member roles while the inspector is open", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const channelRow = await screen.findByRole("row", { name: /alpha_login/ });
    fireEvent.click(channelRow);
    const table = channelRow.closest("table");
    if (table === null) throw new Error("Kanalübersicht-Tabelle fehlt");
    expect(table).toHaveClass("platform-channel-table--inspector-open");
    expect(within(table).queryByRole("columnheader", { name: "Kennung" })).not.toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(4);
    expect(within(table).getByRole("columnheader", { name: "Identität" })).toBeInTheDocument();
    expect(within(channelRow).getByRole("rowheader")).toHaveAttribute("title", "123");

    const role = await screen.findByRole("combobox", { name: "Rolle: Helfer" });
    expect(role).toHaveClass("mantine-Select-input");
    expect(role).not.toBeInstanceOf(HTMLSelectElement);
    expect(role).not.toBeDisabled();
  });

  it("asks for confirmation before removing a member and does not act yet", async () => {
    const fetcher = setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const helferZeile = await screen.findByRole("row", { name: /Helfer/ });
    const remove = within(helferZeile).getByRole("button", { name: "Entfernen" });
    fireEvent.click(remove);

    expect(await screen.findByRole("alertdialog", { name: /Zugriff für Helfer wirklich entfernen/ })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input, init]) => requestUrl(input).pathname.endsWith("/members/456") && init?.method === "DELETE")).toBe(false);
  });

  it("shows the broadcaster row's remove button disabled with a reason", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const broadcasterZeile = await screen.findByRole("row", { name: /Alpha/ });
    const remove = within(broadcasterZeile).getByRole("button", { name: "Entfernen" });

    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", "Die Broadcaster-Rolle kann der Betreiber nicht entfernen.");
    expect(remove).toHaveAccessibleDescription("Die Broadcaster-Rolle kann der Betreiber nicht entfernen.");
  });

  it("builds the invite link from the selected channel's login", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const link = await screen.findByRole("textbox", { name: "Einladungslink" });

    expect(link).toHaveValue("http://localhost:3000/auth/login?channel=alpha_login");
  });

  it("puts hidden Tabler icons in the member-search field and copy action", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const inspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    const search = within(inspector).getByRole("textbox", { name: "Twitch-Login" });
    expect(search).toHaveAccessibleName("Twitch-Login");
    expect(search.closest(".mantine-Input-wrapper")?.querySelector("svg[aria-hidden='true']")).not.toBeNull();

    const copy = within(inspector).getByRole("button", { name: "Link kopieren" });
    expect(copy).toHaveAccessibleName("Link kopieren");
    expect(copy.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });

  it("shows the display name in the platform audit log, falling back to the ID when it can't be resolved", async () => {
    setUpPlatform(true, {
      entries: [{
        auditId: "audit-1",
        actorUserId: "26876135",
        actorLogin: "esembe",
        actorDisplayName: "Esembe",
        actorKind: "platform_admin",
        createdAt: "2026-09-18T00:00:00.000Z",
        channelId: "123",
        moduleId: null,
        action: "channel.released",
        before: "{}",
        after: "{}",
      }, {
        auditId: "audit-2",
        actorUserId: "gelöscht",
        actorLogin: null,
        actorDisplayName: null,
        actorKind: "platform_admin",
        createdAt: "2026-09-18T00:00:01.000Z",
        channelId: "123",
        moduleId: null,
        action: "channel.full_consent_changed",
        before: "{}",
        after: "{}",
      }],
      nextCursor: null,
    });
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const audit = await screen.findByRole("region", { name: "Betreiber-Audit" });
    expect(await within(audit).findByText("Betreiber · Esembe")).toBeInTheDocument();
    expect(await within(audit).findByText("Betreiber · gelöscht")).toBeInTheDocument();
    expect(within(audit).queryByText("Betreiber · 26876135")).not.toBeInTheDocument();
  });

  it("shows the invite link only in the selected channel's editor", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const overview = await screen.findByRole("region", { name: "Kanalübersicht" });
    expect(within(overview).queryByRole("textbox", { name: "Einladungslink" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const editor = await within(overview).findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    expect(await within(editor).findByRole("textbox", { name: "Einladungslink" })).toBeInTheDocument();
    expect(within(overview).getByRole("region", { name: "Einladungslink" })).toContainElement(within(editor).getByRole("textbox", { name: "Einladungslink" }));
  });

  it("arranges the channel overview and channel inspector as direct region children", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const row = await screen.findByRole("row", { name: /alpha_login/ });
    fireEvent.click(row);
    const bereich = screen.getByRole("region", { name: "Kanalübersicht" });
    expect(bereich.children).toHaveLength(1);
    const listDetail = bereich.children[0];
    expect(listDetail).toHaveClass("list-detail", "list-detail--open");
    expect(listDetail?.children[0]).toHaveClass("list-detail__list");
    expect(listDetail?.children[2]).toHaveClass("list-detail__inspector");
    expect(listDetail?.querySelector(".list-detail__inspector")?.firstElementChild).toHaveClass("sub-inspector");
  });

  it("closes the platform channel inspector by button and Escape, returning focus to the row", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const row = await screen.findByRole("row", { name: /alpha_login/ });
    row.focus();
    fireEvent.click(row);
    expect(row).toHaveFocus();
    await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    const closeButton = screen.getByRole("button", { name: "Schließen" });
    closeButton.focus();
    fireEvent.click(closeButton);
    expect(screen.queryByRole("region", { name: "Kanal bearbeiten: Alpha" })).not.toBeInTheDocument();
    expect(row).toHaveAttribute("aria-selected", "false");
    expect(row).toHaveFocus();

    fireEvent.click(row);
    const reopenedInspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    expect(reopenedInspector).toBeInTheDocument();
    expect(row).toHaveFocus();
    const reopenedCloseButton = within(reopenedInspector).getByRole("button", { name: "Schließen" });
    reopenedCloseButton.focus();
    fireEvent.keyDown(reopenedCloseButton, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Kanal bearbeiten: Alpha" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });

  it("opens channel access grant in the inspector column and switches without double-occupying it", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const bereich = await screen.findByRole("region", { name: "Kanalübersicht" });
    expect(bereich.children).toHaveLength(1);
    expect(bereich.children[0]).not.toHaveClass("list-detail--open");
    const plus = within(bereich).getByRole("button", { name: "Kanal freigeben" });
    fireEvent.click(plus);
    const freigabe = await screen.findByRole("region", { name: "Kanal freigeben" });
    expect(bereich.children[0]).toHaveClass("list-detail--open");

    const row = await screen.findByRole("row", { name: /alpha_login/ });
    fireEvent.click(row);
    expect(screen.queryByRole("region", { name: "Kanal freigeben" })).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" })).toBeInTheDocument();

    fireEvent.click(plus);
    expect(screen.queryByRole("region", { name: "Kanal bearbeiten: Alpha" })).not.toBeInTheDocument();
    const reopenedFreigabe = await screen.findByRole("region", { name: "Kanal freigeben" });
    expect(row).toHaveAttribute("aria-selected", "false");

    fireEvent.click(within(reopenedFreigabe).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("region", { name: "Kanal freigeben" })).not.toBeInTheDocument();
    expect(plus).toHaveFocus();

    fireEvent.click(plus);
    const escapedFreigabe = await screen.findByRole("region", { name: "Kanal freigeben" });
    fireEvent.keyDown(escapedFreigabe, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Kanal freigeben" })).not.toBeInTheDocument();
    expect(plus).toHaveFocus();
    expect(freigabe).not.toBeInTheDocument();
  });

  it("still grants a channel access through the open form", async () => {
    const freigegeben = { ...channel };
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(response({ channels: [], platformAdmin: true }));
      if (url.pathname === "/api/platform") return Promise.resolve(response({ channels: [freigegeben] }));
      if (url.pathname === "/api/platform/audit") return Promise.resolve(response({ entries: [], nextCursor: null }));
      if (url.pathname === "/api/platform/channels/123/members") return Promise.resolve(response(members));
      if (url.pathname === "/api/platform/users") return Promise.resolve(response({ user: { userId: "789", login: "beta_login", displayName: "Beta" } }));
      if (url.pathname === "/api/csrf") return Promise.resolve(response({ token: "csrf" }));
      if (url.pathname === "/api/platform/channels" && init?.method === "POST") return Promise.resolve(response({ channel: freigegeben }));
      return Promise.resolve(response({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const plus = await screen.findByRole("button", { name: "Kanal freigeben" });
    fireEvent.click(plus);
    const freigabe = await screen.findByRole("region", { name: "Kanal freigeben" });
    fireEvent.change(within(freigabe).getByRole("textbox", { name: "Twitch-Login" }), { target: { value: "beta_login" } });
    fireEvent.click(within(freigabe).getByRole("button", { name: "Nutzer suchen" }));
    expect(await within(freigabe).findByText(/Beta/)).toBeInTheDocument();
    fireEvent.click(within(freigabe).getByRole("button", { name: "Kanal freigeben" }));
    fireEvent.click(await within(freigabe).findByRole("button", { name: "Endgültig freigeben" }));

    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => requestUrl(input).pathname === "/api/platform/channels" && init?.method === "POST")).toBe(true));
  });
});
