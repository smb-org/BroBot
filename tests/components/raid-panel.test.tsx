import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModulePage } from "../../src/dashboard/module-panels";
import { UiProvider } from "../../src/dashboard/ui";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const settings = {
  shoutoutEnabled: false,
  shoutoutThreshold: 3,
  textThreshold: 3,
  textLong: "Voll {channel} {viewers}",
  textShort: "Klein {channel} {viewers}",
  textLongTarget: "channel_default",
  textShortTarget: "channel_default",
};
const initialLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");

const renderRaid = (fetcher: typeof fetch, ownRole: "manager" | "operator" = "manager"): ReturnType<typeof renderWithQuery> => {
  vi.stubGlobal("fetch", fetcher);
  return renderWithQuery(<UiProvider><ModulePage
    channelId="kanal-a"
    moduleId="raid"
    ownRole={ownRole}
    modules={[{ id: "raid", enabled: true, settings: "{}" }]}
    activeModules={[{ moduleId: "raid", settings: "{}" }]}
    onNavigate={vi.fn()}
    onToggle={vi.fn()}
  /></UiProvider>);
};

const settingsFetch = (patch: (body: unknown) => Response = (body) => {
  const request = body as { revision: number; settings: typeof settings };
  return jsonResponse({ settings: request.settings, revision: request.revision + 1, warnings: [] });
}) =>
  vi.fn<typeof fetch>((input, init) => {
    const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
    if (path.endsWith("/settings") && init?.method === "PATCH") return Promise.resolve(patch(typeof init.body === "string" ? JSON.parse(init.body) as unknown : null));
    if (path.includes("/modules/raid/") && path.endsWith("/settings")) return Promise.resolve(jsonResponse({ settings, revision: 1, variables: [] }));
    if (path === "/api/channels/kanal-a/settings") return Promise.resolve(jsonResponse({ defaultChatTarget: "source_only", defaultChatTargetRevision: 1, timeZone: "Europe/Berlin", revision: 1 }));
    if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
    return Promise.resolve(jsonResponse({}, 404));
  });

describe("Raid settings editor declaration", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (initialLanguage !== undefined) Object.defineProperty(window.navigator, "language", initialLanguage);
  });

  it("shows a titled settings page with related raid values grouped into two columns", async () => {
    const fetcher = settingsFetch();
    renderRaid(fetcher);

    expect(await screen.findByRole("heading", { level: 1, name: "Raid-Ankündigungen & Shoutout" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Voller Raid-Text" })).toBeInTheDocument();
    expect(document.querySelector(".settings-page__columns--2")).not.toBeNull();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Text-Schwelle" })).toHaveValue(3);
    expect(screen.getByText("Voll beispielkanal 42")).toBeInTheDocument();
    expect(screen.getAllByText(/Kanaleinstellung verwenden/u)).toHaveLength(2);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Text-Schwelle" }), { target: { value: "4" } });
    expect(screen.getByRole("spinbutton", { name: "Text-Schwelle" })).toHaveValue(4);
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));
    await waitFor(() => expect(document.querySelector(".page-header__save [role=status]")).toHaveTextContent("Raid-Einstellungen gespeichert."));

    const shoutout = screen.getByRole("switch", { name: /Helix-Shoutout automatisch senden/ });
    expect(shoutout).not.toBeChecked();
    expect(screen.queryByRole("spinbutton", { name: "Shoutout-Schwelle" })).not.toBeInTheDocument();
    expect(screen.getByText("Twitch zeigt den raidenden Kanal als Empfehlung im Chat.")).toBeInTheDocument();
    fireEvent.click(shoutout);
    expect(shoutout).toBeChecked();
    expect(await screen.findByRole("spinbutton", { name: "Shoutout-Schwelle" })).toBeEnabled();
  });

  it("keeps a draft after a 409 concurrent settings change", async () => {
    const fetcher = settingsFetch(() => jsonResponse({ error: "module_settings_changed_concurrently" }, 409));
    renderRaid(fetcher);
    const field = await screen.findByRole("textbox", { name: "Voller Raid-Text" });
    fireEvent.change(field, { target: { value: "Mein Entwurf {channel}" } });
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));

    await waitFor(() => expect(document.querySelector(".page-header__save [role=status]")).toHaveTextContent("Raid-Einstellungen wurden inzwischen geändert."));
    expect(field).toHaveValue("Mein Entwurf {channel}");
    expect(screen.getByRole("button", { name: "Serverstand laden" })).toBeEnabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
  });

  it("shows operators the declaration as a read-only property list", async () => {
    renderRaid(settingsFetch(), "operator");

    expect(await screen.findByText("Nur Broadcaster und Verwalter dürfen Module ändern.")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("dl.ui-settings-editor__properties")).not.toBeNull());
    const properties = document.querySelector("dl.ui-settings-editor__properties");
    expect(properties).not.toBeNull();
    expect(within(properties as HTMLElement).getByText("Text-Schwelle")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Voller Raid-Text")).toBeInTheDocument();
    expect(properties).toHaveTextContent("Klein {channel} {viewers}");
    expect(document.querySelectorAll(".page-header__lock")).toHaveLength(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Raid-Einstellungen speichern" })).not.toBeInTheDocument();
  });

  it("follows the browser language for the declaration labels", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    renderRaid(settingsFetch());

    expect(await screen.findByRole("heading", { level: 1, name: "Raid announcements & shoutout" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Full raid text" })).toBeInTheDocument();
  });

  it("clears the saved message when the draft changes and keeps a blank threshold out of the request", async () => {
    const fetcher = settingsFetch();
    renderRaid(fetcher);
    const text = await screen.findByRole("textbox", { name: "Voller Raid-Text" });
    fireEvent.change(text, { target: { value: "Updated {channel}" } });
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));
    await waitFor(() => expect(document.querySelector(".page-header__save [role=status]")).toHaveTextContent("Raid-Einstellungen gespeichert."));
    fireEvent.change(text, { target: { value: "Changed again {channel}" } });
    expect(screen.getByRole("status")).toHaveTextContent("");

    const number = screen.getByRole("spinbutton", { name: "Text-Schwelle" });
    fireEvent.change(number, { target: { value: "" } });
    expect(number).toHaveValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));
    expect(await screen.findByText(/Zahl eingeben\./u)).toBeInTheDocument();
    expect(number).toHaveAttribute("aria-invalid", "true");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(number).toHaveValue(null);
  });
});
