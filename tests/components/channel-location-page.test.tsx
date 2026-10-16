import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelChannelSettings } from "../../src/dashboard/api";
import { ChannelLocationPage } from "../../src/dashboard/ChannelLocationPage";
import { channelSettingsTexts } from "../../src/dashboard/channel-settings-locale";
import { queryKeys } from "../../src/dashboard/data/keys";
import { UiProvider } from "../../src/dashboard/ui";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const settings: PanelChannelSettings = {
  timeZone: "Europe/Berlin",
  revision: 1,
  location: null,
  locationRevision: 1,
  defaultChatTarget: "source_only",
  defaultChatTargetRevision: 1,
};

const inputUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input;

const renderPage = (role: "manager" | "operator" = "manager") => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(settings))));
  return renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role={role} /></UiProvider>);
};

describe("channel location page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the channel time zone and a missing-location warning together", async () => {
    const labels = channelSettingsTexts("de");
    renderPage();

    expect(await screen.findByRole("heading", { name: labels.pageTitle })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: labels.timeZone })).toHaveValue("Europe/Berlin");
    expect(screen.getByText("Standort fehlt")).toBeInTheDocument();
  });

  it("shows read-only time-zone properties and one reason for disabled location actions to operators", async () => {
    const labels = channelSettingsTexts("de");
    renderPage("operator");

    const locationChange = await screen.findByRole("button", { name: labels.locationChange });
    expect(screen.queryByRole("combobox", { name: labels.timeZone })).not.toBeInTheDocument();
    expect(screen.getByText("Europe/Berlin")).toBeInTheDocument();
    expect(locationChange).toBeDisabled();
    expect(screen.getAllByText(labels.readOnly)).toHaveLength(1);
  });

  it("keeps a time zone change as a draft until the page save is pressed", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/settings") && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse(settings));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/settings") && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ ok: true, timeZone: "Europe/Paris", revision: 2 }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithQuery(<UiProvider><ChannelLocationPage channelId="channel-a" role="manager" /></UiProvider>);

    const timeZone = await screen.findByRole("combobox", { name: "Kanalzeitzone" });
    fireEvent.change(timeZone, { target: { value: "Europe/Paris" } });
    fireEvent.click(await screen.findByRole("option", { name: "Europe/Paris", hidden: true }));

    expect(fetcher.mock.calls.some(([input, init]) => inputUrl(input).endsWith("/settings") && init?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => {
      const call = fetcher.mock.calls.find(([input, init]) => inputUrl(input).endsWith("/settings") && init?.method === "PATCH");
      expect(call?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ revision: 1, timeZone: "Europe/Paris" }) });
    });
    expect(await screen.findByRole("combobox", { name: "Kanalzeitzone" })).toHaveValue("Europe/Paris");
  });

  it("preserves a time zone draft and requires reload after a remote revision", async () => {
    const { queryClient } = renderPage();
    const timeZone = await screen.findByRole("combobox", { name: "Kanalzeitzone" });
    fireEvent.change(timeZone, { target: { value: "Europe/Paris" } });
    fireEvent.click(await screen.findByRole("option", { name: "Europe/Paris", hidden: true }));

    queryClient.setQueryData<PanelChannelSettings>(queryKeys.channel("channel-a", "settings"), {
      ...settings,
      revision: 2,
      timeZone: "Europe/Rome",
    });

    expect(timeZone).toHaveValue("Europe/Paris");
    fireEvent.change(timeZone, { target: { value: "Europe/Amsterdam" } });
    fireEvent.click(await screen.findByRole("option", { name: "Europe/Amsterdam", hidden: true }));
    await waitFor(() => {
      expect(screen.getAllByRole("status").some((status) => status.textContent.includes("Die Einstellungen wurden zwischenzeitlich geändert."))).toBe(true);
      expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeEnabled();
    });
  });
});
