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

    expect(screen.getByRole("textbox", { name: "German" })).not.toHaveValue("Unsaved A");
    expect(await screen.findByDisplayValue("Moon B")).toBeInTheDocument();
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
  });
});
