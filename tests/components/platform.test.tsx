import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { PlatformPage } from "../../src/dashboard/platform";
import type { PanelPlatformChannelOverview, PanelSpotifyAccessResponse } from "../../src/panel-contract";
import { UiProvider } from "../../src/dashboard/ui";
import { renderWithQuery as render } from "../query-test-utils";

const response = (inhalt: unknown, status = 200): Response => new Response(JSON.stringify(inhalt), {
  status,
  headers: { "Content-Type": "application/json" },
});

const requestUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input, window.location.origin);
};

const channel: PanelPlatformChannelOverview = {
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
  channels: PanelPlatformChannelOverview[] = [channel],
  spotifyAccess: PanelSpotifyAccessResponse = { usedSlots: 0, limit: 5, channels: [] },
): ReturnType<typeof vi.fn<typeof fetch>> => {
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/channels") return Promise.resolve(response({ channels: [], bot: { status: "connected", reason: null, updatedAt: "2026-09-18T00:00:00.000Z" }, platformAdmin: platform }));
    if (url.pathname === "/api/platform") return Promise.resolve(response({ channels }));
    if (url.pathname === "/api/platform/audit") return Promise.resolve(response(audit));
    if (url.pathname === "/api/platform/spotify-channels") return Promise.resolve(response(spotifyAccess));
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
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  });

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
    fireEvent.click(await screen.findByRole("row", { name: /Helfer/ }));
    const rolle = await screen.findByRole("combobox", { name: "Rolle: Helfer" });

    expect(within(rolle).queryByRole("option", { name: "Broadcaster" })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("option", { name: "Broadcaster" })).toHaveLength(0);
  });

  it("labels each role count in the channel table and its accessible name", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const channelRow = await screen.findByRole("row", { name: /alpha_login/ });
    const table = channelRow.closest("table");
    if (table === null) throw new Error("Kanalübersicht-Tabelle fehlt");
    expect(table).toHaveClass("platform-channel-table");
    expect(within(table).getByRole("columnheader", { name: "Kennung" })).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
    expect(within(channelRow).getByRole("rowheader")).toHaveAttribute("data-label", "Login");
    expect(within(channelRow).getByText("123")).toHaveAttribute("data-label", "Kennung");
    const identityCell = channelRow.querySelector('[data-field="identity"]');
    expect(identityCell).not.toBeNull();
    expect(identityCell).toHaveAttribute("data-label", "Broadcaster-Identität");
    const consentHeader = within(table).getByRole("columnheader", { name: "Zustimmung" });
    const counts = within(channelRow).getByRole("cell", { name: "Broadcaster: 1, Verwalter: 1, Bediener: 0" });
    expect(within(counts).getByText("Broadcaster: 1")).toBeInTheDocument();
    expect(within(counts).getByText("Verwalter: 1")).toBeInTheDocument();
    expect(within(counts).getByText("Bediener: 0")).toBeInTheDocument();
    expect(consentHeader).toHaveAttribute("title", "Vollzustimmung");
  });

  it("keeps Spotify slots in the page overview and scopes inspector status to the selected channel", async () => {
    const otherChannel: PanelPlatformChannelOverview = {
      ...channel,
      channelId: "456",
      login: "viewer_one",
      displayName: "Viewer One",
    };
    setUpPlatform(true, undefined, [channel, otherChannel], {
      usedSlots: 1,
      limit: 5,
      channels: [{ slot: 2, channelId: otherChannel.channelId, login: otherChannel.login, displayName: otherChannel.displayName, enabledAt: "2026-09-19T12:00:00.000Z" }],
    });
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const slotOverview = await screen.findByRole("region", { name: "Spotify-Platzübersicht" });
    expect(within(slotOverview).getByText("1 von 5 Spotify-Plätzen belegt")).toBeInTheDocument();
    expect(within(slotOverview).getByText("2. @viewer_one")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const alphaInspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    const alphaSpotify = within(alphaInspector).getByRole("region", { name: "Spotify-Freigabe" });
    expect(within(alphaSpotify).getByText("Spotify nicht freigeschaltet")).toBeInTheDocument();
    expect(within(alphaSpotify).queryByText("@viewer_one")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("row", { name: /viewer_one/ }));
    const viewerInspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Viewer One" });
    expect(within(viewerInspector).getByText("Spotify freigeschaltet · Platz 2")).toBeInTheDocument();
  });

  it("hides the channel id and edits a selected member role in the inspector", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const channelRow = await screen.findByRole("row", { name: /alpha_login/ });
    fireEvent.click(channelRow);
    const table = channelRow.closest("table");
    if (table === null) throw new Error("Kanalübersicht-Tabelle fehlt");
    expect(table).toHaveClass("platform-channel-table--inspector-open");
    expect(within(table).queryByRole("columnheader", { name: "Kennung" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "Mitglieder" })).not.toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(table).getByRole("columnheader", { name: "Identität" })).toBeInTheDocument();
    expect(within(channelRow).getByRole("rowheader")).toHaveAttribute("title", "123");

    fireEvent.click(await screen.findByRole("row", { name: /Helfer/ }));
    const role = await screen.findByRole("combobox", { name: "Rolle: Helfer" });
    expect(role).toHaveClass("ui-select__trigger");
    expect(role).not.toBeInstanceOf(HTMLSelectElement);
    expect(role).not.toBeDisabled();
  });

  it("asks for confirmation before removing a member and does not act yet", async () => {
    const fetcher = setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const helferZeile = await screen.findByRole("row", { name: /Helfer/ });
    fireEvent.click(helferZeile);
    const remove = await screen.findByRole("button", { name: "Entfernen" });
    fireEvent.click(remove);

    const dialog = await screen.findByRole("dialog", { name: "Zugriff für „Helfer“ entfernen?" });
    expect(dialog).toHaveTextContent("Helfer verliert den Zugriff auf diesen Kanal.");
    expect(within(dialog).getByRole("button", { name: "Mitgliedszugriff entfernen: Helfer" })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input, init]) => requestUrl(input).pathname.endsWith("/members/456") && init?.method === "DELETE")).toBe(false);
  });

  it("shows the broadcaster row's remove button disabled with a reason", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const broadcasterZeile = await screen.findByRole("row", { name: /Alpha/ });
    fireEvent.click(broadcasterZeile);
    const remove = await screen.findByRole("button", { name: "Entfernen" });

    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", "Die Broadcaster-Rolle kann der Betreiber nicht entfernen.");
    const reasonId = remove.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId ?? "")).toHaveTextContent("Die Broadcaster-Rolle kann der Betreiber nicht entfernen.");
    expect(remove).toHaveAccessibleDescription("Die Broadcaster-Rolle kann der Betreiber nicht entfernen.");
  });

  it("keeps the invitation link prominent while the channel has not connected", async () => {
    setUpPlatform(true, undefined, [{ ...channel, fullConsent: false }]);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const link = await screen.findByRole("textbox", { name: "Einladungslink" });

    expect(link).toHaveValue("http://localhost:3000/auth/login?channel=alpha_login");
  });

  it("shows only the compact copy action after the channel connects", async () => {
    setUpPlatform(true, undefined, [{ ...channel, broadcasterConnected: true }]);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const inspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    const invitation = within(inspector).getByRole("region", { name: "Einladungslink" });
    expect(within(invitation).queryByRole("textbox", { name: "Einladungslink" })).not.toBeInTheDocument();
    expect(within(invitation).getByRole("button", { name: "Link kopieren" })).toBeInTheDocument();
  });

  it("keeps the full invitation link while a connected channel has no consent", async () => {
    setUpPlatform(true, undefined, [{ ...channel, broadcasterConnected: true, fullConsent: false }]);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const inspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    const invitation = within(inspector).getByRole("region", { name: "Einladungslink" });
    expect(within(invitation).getByRole("textbox", { name: "Einladungslink" })).toBeInTheDocument();
    expect(within(invitation).getByText("Diesen Link bekommt der Streamer. Er startet die Twitch-Zustimmung für den gewählten Kanal.")).toBeInTheDocument();
  });

  it("shows the Add member title only once in the channel inspector", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const inspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    expect(within(inspector).getAllByRole("heading", { name: "Mitglied hinzufügen" })).toHaveLength(1);
  });

  it("shows the shared Twitch user field and puts a hidden lucide icon on the copy action", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const inspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    const search = within(inspector).getByRole("combobox", { name: "Twitch-Login" });
    expect(search).toHaveAccessibleName("Twitch-Login");

    const copy = within(inspector).getByRole("button", { name: "Link kopieren" });
    expect(copy).toHaveAccessibleName("Link kopieren");
    expect(copy.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });

  it("shows the display name in the platform audit log, falling back to the ID when it can't be resolved", async () => {
    setUpPlatform(true, {
      entries: [{
        auditId: "audit-1",
        actorUserId: "test-operator",
        actorLogin: "operator_test",
        actorDisplayName: "Operator Test",
        actorKind: "platform_admin",
        createdAt: "2026-09-18T00:00:00.000Z",
        channelId: "123",
        moduleId: null,
        action: "channel.released",
        before: "{}",
        after: "{}",
      }, {
        auditId: "audit-member-role",
        actorUserId: "test-operator",
        actorLogin: "operator_test",
        actorDisplayName: "Operator Test",
        actorKind: "platform_admin",
        createdAt: "2026-09-18T00:00:00.500Z",
        channelId: "123",
        moduleId: null,
        action: "member.role_changed",
        before: JSON.stringify({ userId: "viewer_one_id", role: "manager" }),
        after: JSON.stringify({ userId: "viewer_one_id", role: "operator" }),
        subjectUserId: "viewer_one_id",
        subjectLogin: "viewer_one",
        subjectDisplayName: "Viewer One",
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

    fireEvent.click(await screen.findByRole("tab", { name: "Audit" }));
    const audit = await screen.findByRole("region", { name: "Betreiber-Audit" });
    expect(within(audit).queryByText("Betreiber · test-operator")).not.toBeInTheDocument();
    expect(within(audit).getByText("Betreiber · Operator Test gab den Kanal alpha_login frei")).toHaveClass("audit-sentence");
    expect(within(audit).getByText("Betreiber · Operator Test änderte die Rolle von Viewer One von Verwalter zu Bediener")).toHaveClass("audit-sentence");
    expect(within(audit).getByText("Betreiber · gelöscht änderte die Vollzustimmung für alpha_login von — zu —")).toBeInTheDocument();
    expect(within(audit).queryByRole("columnheader", { name: "Akteur" })).not.toBeInTheDocument();
  });

  it("shows the prominent invitation link only in the selected channel's editor", async () => {
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

  it("opens channel access grant in a dialog and switches cleanly with the channel inspector", async () => {
    setUpPlatform(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const bereich = await screen.findByRole("region", { name: "Kanalübersicht" });
    expect(bereich.children).toHaveLength(1);
    expect(bereich.children[0]).not.toHaveClass("list-detail--open");
    const plus = screen.getByRole("button", { name: "Kanal freigeben" });
    expect(plus.parentElement).toHaveClass("page-header__actions");
    fireEvent.click(plus);
    const freigabe = await screen.findByRole("dialog", { name: "Kanal freigeben" });
    expect(bereich.children[0]).not.toHaveClass("list-detail--open");

    fireEvent.click(within(freigabe).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Kanal freigeben" })).not.toBeInTheDocument());

    const row = await screen.findByRole("row", { name: /alpha_login/ });
    row.focus();
    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Kanal freigeben" })).not.toBeInTheDocument());
    expect(await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" })).toBeInTheDocument();

    plus.focus();
    fireEvent.click(plus);
    expect(screen.queryByRole("region", { name: "Kanal bearbeiten: Alpha" })).not.toBeInTheDocument();
    const reopenedFreigabe = await screen.findByRole("dialog", { name: "Kanal freigeben" });
    expect(row).toHaveAttribute("aria-selected", "false");

    fireEvent.click(within(reopenedFreigabe).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Kanal freigeben" })).not.toBeInTheDocument());
    expect(plus).toHaveFocus();

    fireEvent.click(plus);
    const escapedFreigabe = await screen.findByRole("dialog", { name: "Kanal freigeben" });
    fireEvent.keyDown(escapedFreigabe, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Kanal freigeben" })).not.toBeInTheDocument());
    expect(plus).toHaveFocus();
    expect(freigabe).not.toBeInTheDocument();
  });

  it("still grants a channel access through the open form", async () => {
    const freigegeben = { ...channel };
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(response({ channels: [], platformAdmin: true }));
      if (url.pathname === "/api/platform") return Promise.resolve(response({ channels: [freigegeben] }));
      if (url.pathname === "/api/platform/spotify-channels") return Promise.resolve(response({ usedSlots: 0, limit: 5, channels: [] }));
      if (url.pathname === "/api/platform/audit") return Promise.resolve(response({ entries: [], nextCursor: null }));
      if (url.pathname === "/api/platform/channels/123/members") return Promise.resolve(response(members));
      if (url.pathname === "/api/platform/twitch/user-suggestions") return Promise.resolve(response({ users: [{ userId: "789", login: "beta_login", displayName: "Beta", profileImageUrl: null }], partial: false }));
      if (url.pathname === "/api/csrf") return Promise.resolve(response({ token: "csrf" }));
      if (url.pathname === "/api/platform/channels" && init?.method === "POST") return Promise.resolve(response({ channel: freigegeben }));
      return Promise.resolve(response({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const plus = await screen.findByRole("button", { name: "Kanal freigeben" });
    fireEvent.click(plus);
    const freigabe = await screen.findByRole("dialog", { name: "Kanal freigeben" });
    fireEvent.change(within(freigabe).getByRole("combobox", { name: "Twitch-Login" }), { target: { value: "beta_login" } });
    fireEvent.click(await screen.findByRole("option", { name: /Beta/u }));
    expect(await within(freigabe).findByText(/Beta/)).toBeInTheDocument();
    fireEvent.click(within(freigabe).getByRole("button", { name: "Kanal freigeben" }));
    fireEvent.click(await screen.findByRole("button", { name: "Endgültig freigeben" }));

    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => requestUrl(input).pathname === "/api/platform/channels" && init?.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Kanal freigeben" })).not.toBeInTheDocument());
  });

  describe("load errors", () => {
    /** Fails the given platform endpoint until `state.fail` is cleared; everything else answers normally. */
    const failing = (path: "/api/platform" | "/api/platform/audit"): { fail: boolean } => {
      const state = { fail: true };
      const inner = setUpPlatform(true);
      vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) =>
        state.fail && requestUrl(input).pathname === path
          ? Promise.resolve(response({ error: "backend down" }, 500))
          : inner(input, init)));
      return state;
    };

    it("shows the audit error with a retry instead of a skeleton and keeps the channel list usable", async () => {
      const state = failing("/api/platform/audit");
      window.history.replaceState({}, "", "/betreiber");
      render(<DashboardApp />);

      expect(await screen.findByText("alpha_login")).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("tab", { name: "Audit" }));
      const audit = await screen.findByRole("region", { name: "Betreiber-Audit" });
      expect(await within(audit).findByRole("alert")).toBeInTheDocument();

      state.fail = false;
      fireEvent.click(within(audit).getByRole("button", { name: "Erneut versuchen" }));
      expect(await within(audit).findByText("Noch keine Betreiberhandlungen protokolliert.")).toBeInTheDocument();
    });

    it("shows the channel list error with a retry while the audit still loads", async () => {
      const state = failing("/api/platform");
      window.history.replaceState({}, "", "/betreiber");
      render(<DashboardApp />);

      const overview = await screen.findByRole("region", { name: "Kanalübersicht" });
      expect(await within(overview).findByRole("alert")).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("tab", { name: "Audit" }));
      const audit = await screen.findByRole("region", { name: "Betreiber-Audit" });
      expect(within(audit).queryByRole("alert")).not.toBeInTheDocument();

      state.fail = false;
      fireEvent.click(await screen.findByRole("tab", { name: "Kanäle" }));
      fireEvent.click(within(await screen.findByRole("region", { name: "Kanalübersicht" })).getByRole("button", { name: "Erneut versuchen" }));
      expect(await screen.findByText("alpha_login")).toBeInTheDocument();
    });
    it("keeps the same reserved box for loading and error, and ignores a retry that resolves after unmount", async () => {
      const inner = setUpPlatform(true);
      let mode: "fail" | "hang" = "fail";
      let release: () => void = () => {};
      vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
        if (requestUrl(input).pathname !== "/api/platform/audit") return inner(input, init);
        if (mode === "fail") return Promise.resolve(response({ error: "backend down" }, 500));
        return new Promise<Response>((resolve) => { release = () => { resolve(response({ error: "expired" }, 401)); }; });
      }));
      const onAuth = vi.fn();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      window.history.replaceState({}, "", "/betreiber");
      const view = render(<UiProvider><PlatformPage onAuthenticationRequired={onAuth} /></UiProvider>);

      fireEvent.click(await screen.findByRole("tab", { name: "Audit" }));
      const audit = await screen.findByRole("region", { name: "Betreiber-Audit" });
      await within(audit).findByRole("alert");
      const box = (): HTMLElement => audit.querySelector<HTMLElement>(".ui-load-state") ?? document.body;
      expect(box().style.minHeight).toBe("280px");

      mode = "hang";
      fireEvent.click(within(audit).getByRole("button", { name: "Erneut versuchen" }));
      await waitFor(() => expect(box().dataset.status).toBe("loading"));
      expect(box().style.minHeight).toBe("280px");
      expect(box().querySelectorAll(".ui-load-state__reserved-lines > span").length).toBeLessThanOrEqual(6);

      view.unmount();
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onAuth).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });
  });
});
