import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { moduleQueryKey } from "../../src/dashboard/data";
import MoonSettingsPanel from "../../src/modules/moon/panel/settings";
import { renderWithQuery } from "../query-test-utils";

const mocks = vi.hoisted(() => ({ fetchMoonSettings: vi.fn(), saveMoonSettings: vi.fn() }));
vi.mock("../../src/modules/moon/panel/service", () => mocks);

describe("moon settings panel", () => {
  beforeEach(() => {
    mocks.fetchMoonSettings.mockReset().mockResolvedValue({ errorTexts: { de: "", en: "" }, revision: 1 });
    mocks.saveMoonSettings.mockReset();
  });
  afterEach(() => cleanup());

  it("keeps the read-only reason in a reserved form slot", async () => {
    renderWithQuery(<UiProvider><MoonSettingsPanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    expect(await screen.findByTestId("moon-settings-permission-slot")).toBeInTheDocument();
  });

  it("does not show a saved draft from another channel", async () => {
    mocks.fetchMoonSettings.mockImplementation((channelId: string) => Promise.resolve(channelId === "channel-a"
      ? { errorTexts: { de: "Moon A", en: "" }, revision: 1 }
      : { errorTexts: { de: "Moon B", en: "" }, revision: 1 }));
    function SwitchChannel() {
      const [channelId, setChannelId] = useState("channel-a");
      return <UiProvider>
        <button onClick={() => setChannelId("channel-b")}>Switch channel</button>
        <MoonSettingsPanel channelId={channelId} language="en" canManage />
      </UiProvider>;
    }
    renderWithQuery(<SwitchChannel />);
    expect(await screen.findByDisplayValue("Moon A")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "German" }), { target: { value: "Unsaved A" } });

    fireEvent.click(screen.getByRole("button", { name: "Switch channel" }));

    const germanField = await screen.findByRole("textbox", { name: "German" });
    expect(germanField).not.toHaveValue("Unsaved A");
    expect(await screen.findByDisplayValue("Moon B")).toBeInTheDocument();
  });

  it("shows cached settings immediately when the panel is reopened", async () => {
    mocks.fetchMoonSettings.mockResolvedValue({ errorTexts: { de: "Cached moon text", en: "" }, revision: 1 });
    function TogglePanel() {
      const [open, setOpen] = useState(true);
      return <UiProvider>
        <button onClick={() => setOpen((current) => !current)}>Toggle panel</button>
        {open ? <MoonSettingsPanel channelId="channel-a" language="en" canManage /> : null}
      </UiProvider>;
    }
    renderWithQuery(<TogglePanel />, undefined, { gcTime: 600_000 });
    expect(await screen.findByDisplayValue("Cached moon text")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));

    expect(screen.getByRole("textbox", { name: "German" })).toHaveValue("Cached moon text");
  });

  it("retries a failed settings read", async () => {
    mocks.fetchMoonSettings.mockRejectedValueOnce(new Error("offline"));
    renderWithQuery(<UiProvider><MoonSettingsPanel channelId="channel-a" language="en" canManage /></UiProvider>);

    expect(await screen.findByText("Moon settings could not be loaded.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry|erneut versuchen/iu }));

    expect(await screen.findByRole("textbox", { name: "German" })).toBeEnabled();
  });

  it("keeps an unsaved draft visible when a newer settings revision arrives", async () => {
    const view = renderWithQuery(<UiProvider><MoonSettingsPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    const germanField = await screen.findByRole("textbox", { name: "German" });
    await waitFor(() => expect(germanField).toBeEnabled());
    fireEvent.change(germanField, { target: { value: "Unsaved moon text" } });

    act(() => {
      view.queryClient.setQueryData(moduleQueryKey("channel-a", "moon", "unavailable-texts"), {
        errorTexts: { de: "Remote moon text", en: "" },
        revision: 2,
      });
    });

    expect(germanField).toHaveValue("Unsaved moon text");
    mocks.saveMoonSettings.mockResolvedValue({ errorTexts: { de: "Unsaved moon text", en: "" }, revision: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Save error texts" }));
    await waitFor(() => expect(mocks.saveMoonSettings).toHaveBeenCalledWith("channel-a", {
      revision: 1,
      errorTexts: { de: "Unsaved moon text", en: "" },
    }));
  });
});
