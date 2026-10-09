import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { moduleQueryKey } from "../../src/dashboard/data";
import SunSettingsPanel from "../../src/modules/sun/panel/settings";
import { renderWithQuery } from "../query-test-utils";

const mocks = vi.hoisted(() => ({ fetchSunSettings: vi.fn(), saveSunSettings: vi.fn() }));
vi.mock("../../src/modules/sun/panel/service", () => mocks);

describe("sun settings panel", () => {
  beforeEach(() => {
    mocks.fetchSunSettings.mockReset().mockResolvedValue({ errorTexts: { de: "", en: "" }, revision: 1 });
    mocks.saveSunSettings.mockReset();
  });
  afterEach(() => cleanup());

  it("keeps the read-only reason in a reserved form slot", async () => {
    renderWithQuery(<UiProvider><SunSettingsPanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    expect(await screen.findByTestId("sun-settings-permission-slot")).toBeInTheDocument();
  });

  it("shows cached settings immediately when the panel is reopened", async () => {
    mocks.fetchSunSettings.mockResolvedValue({ errorTexts: { de: "Cached sun text", en: "" }, revision: 1 });
    function TogglePanel() {
      const [open, setOpen] = useState(true);
      return <UiProvider>
        <button onClick={() => setOpen((current) => !current)}>Toggle panel</button>
        {open ? <SunSettingsPanel channelId="channel-a" language="en" canManage /> : null}
      </UiProvider>;
    }
    renderWithQuery(<TogglePanel />, undefined, { gcTime: 600_000 });
    expect(await screen.findByDisplayValue("Cached sun text")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));

    expect(screen.getByRole("textbox", { name: "German" })).toHaveValue("Cached sun text");
  });

  it("keeps an unsaved draft visible when a newer settings revision arrives", async () => {
    const view = renderWithQuery(<UiProvider><SunSettingsPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    const germanField = await screen.findByRole("textbox", { name: "German" });
    await waitFor(() => expect(germanField).toBeEnabled());
    fireEvent.change(germanField, { target: { value: "Unsaved sun text" } });

    act(() => {
      view.queryClient.setQueryData(moduleQueryKey("channel-a", "sun", "error-texts"), {
        errorTexts: { de: "Remote sun text", en: "" },
        revision: 2,
      });
    });

    expect(germanField).toHaveValue("Unsaved sun text");
  });
});
