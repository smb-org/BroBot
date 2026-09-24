import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModulePage } from "../../src/dashboard/module-panels";
import { UiProvider } from "../../src/dashboard/ui";
import { jsonResponse } from "../unit/fixtures";

const settings = {
  shoutoutEnabled: false,
  shoutoutThreshold: 3,
  textThreshold: 3,
  textLong: "Voll {channel} {viewers}",
  textShort: "Klein {channel} {viewers}",
};
const initialLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");

const renderRaid = (fetcher: typeof fetch, ownRole: "manager" | "operator" = "manager"): ReturnType<typeof render> => {
  vi.stubGlobal("fetch", fetcher);
  return render(<UiProvider><ModulePage
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
    if (path.endsWith("/settings")) return Promise.resolve(jsonResponse({ settings, revision: 1, variables: [] }));
    if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
    return Promise.resolve(jsonResponse({}, 404));
  });

describe("Raid settings editor declaration", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (initialLanguage !== undefined) Object.defineProperty(window.navigator, "language", initialLanguage);
  });

  it("shows the two icon tabs, stepper, switch-card threshold, and renderRaidText preview", async () => {
    const fetcher = settingsFetch();
    renderRaid(fetcher);

    const messagesTab = await screen.findByRole("tab", { name: "Nachrichten" });
    const shoutoutTab = screen.getByRole("tab", { name: "Shoutout" });
    expect(messagesTab.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(shoutoutTab.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Text-Schwelle" })).toHaveValue("3");
    expect(screen.getByText("Voll beispielkanal 42")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Text-Schwelle erhöhen" }));
    expect(screen.getByRole("spinbutton", { name: "Text-Schwelle" })).toHaveValue("4");
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Raid-Einstellungen gespeichert.");

    fireEvent.click(shoutoutTab);
    const shoutout = screen.getByRole("switch", { name: /Helix-Shoutout automatisch senden/ });
    const threshold = screen.getByRole("spinbutton", { name: "Shoutout-Schwelle" });
    expect(shoutout).not.toBeChecked();
    expect(threshold).toBeDisabled();
    expect(screen.getAllByText("Shoutout ist ausgeschaltet.")).toHaveLength(2);
    fireEvent.click(shoutout);
    expect(shoutout).toBeChecked();
    expect(threshold).toBeEnabled();
  });

  it("keeps a draft after a 409 concurrent settings change", async () => {
    const fetcher = settingsFetch(() => jsonResponse({ error: "module_settings_changed_concurrently" }, 409));
    renderRaid(fetcher);
    const field = await screen.findByRole("textbox", { name: "Voller Raid-Text" });
    fireEvent.change(field, { target: { value: "Mein Entwurf {channel}" } });
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Raid-Einstellungen wurden inzwischen geändert.");
    expect(field).toHaveValue("Mein Entwurf {channel}");
    expect(screen.getByRole("button", { name: "Serverstand laden" })).toBeEnabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
  });

  it("shows operators the declaration as a read-only property list", async () => {
    renderRaid(settingsFetch(), "operator");

    expect(await screen.findByText("Nur Broadcaster und Verwalter dürfen Raid-Einstellungen ändern.")).toBeInTheDocument();
    const properties = document.querySelector("dl.ui-settings-editor__properties");
    expect(properties).not.toBeNull();
    expect(within(properties as HTMLElement).getByText("Text-Schwelle")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Voller Raid-Text")).toBeInTheDocument();
    expect(properties).toHaveTextContent("Klein {channel} {viewers}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Raid-Einstellungen speichern" })).not.toBeInTheDocument();
  });

  it("follows the browser language for the declaration labels", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    renderRaid(settingsFetch());

    expect(await screen.findByRole("tab", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Shoutout" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Full raid text" })).toBeInTheDocument();
  });

  it("clears the saved message when the draft changes and keeps a blank threshold out of the request", async () => {
    const fetcher = settingsFetch();
    renderRaid(fetcher);
    const text = await screen.findByRole("textbox", { name: "Voller Raid-Text" });
    fireEvent.change(text, { target: { value: "Updated {channel}" } });
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Raid-Einstellungen gespeichert.");
    fireEvent.change(text, { target: { value: "Changed again {channel}" } });
    expect(screen.getByRole("status")).toHaveTextContent("");

    const number = screen.getByRole("spinbutton", { name: "Text-Schwelle" });
    fireEvent.change(number, { target: { value: "" } });
    expect(number).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));
    expect(await screen.findByText(/Zahl eingeben\./u)).toBeInTheDocument();
    expect(number).toHaveAttribute("aria-invalid", "true");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(number).toHaveValue("");
  });
});
