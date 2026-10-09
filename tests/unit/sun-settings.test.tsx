import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SunSettings } from "../../src/modules/sun/contracts";
import { UiProvider } from "../../src/dashboard/ui";
import { renderWithQuery } from "../query-test-utils";

const service = vi.hoisted(() => ({
  fetchSunSettings: vi.fn(),
  saveSunSettings: vi.fn(),
}));

vi.mock("../../src/modules/sun/panel/service", () => service);

import SunSettingsPanel from "../../src/modules/sun/panel/settings";

afterEach(() => vi.clearAllMocks());

describe("sun module settings", () => {
  it("shows operators the read-only error texts", async () => {
    const settings: SunSettings = {
      errorTexts: { de: "Eigener deutscher Fehler", en: "Custom English fallback" },
      revision: 3,
    };
    service.fetchSunSettings.mockResolvedValue(settings);

    const { container } = renderWithQuery(
      <UiProvider>
        <SunSettingsPanel
          channelId="sun-channel"
          language="en"
          canManage={false}
        />
      </UiProvider>,
    );

    expect(await screen.findByText("Operators can read this setting but cannot change it.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "German" })).toHaveValue("Eigener deutscher Fehler"));
    expect(screen.getByRole("textbox", { name: "English" })).toHaveValue("Custom English fallback");
    expect(container.querySelector("dl.properties")).toBeNull();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getAllByRole("textbox").every((field) => field.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: "Save error texts" })).toBeDisabled();
  });
});
