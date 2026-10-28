import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImmediateActions } from "../../src/dashboard/ImmediateActions";
import { dashboardLanguage, dashboardTexts } from "../../src/dashboard/locale";
import { UiProvider } from "../../src/dashboard/ui";
import { blitzActionTexts } from "../../src/modules/blitz_round/locale";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Blitz cockpit activation", () => {
  it.each(["absent", "disabled"] as const)("hides the %s module action [protects=only enabled modules contribute cockpit actions and availability requests; fails_when=an absent or disabled Blitz module adds a tile, changes the singular count, or polls availability; no_claim=does not verify server authorization or browser geometry]", (state) => {
    const requests = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", requests);
    const { container } = renderWithQuery(<UiProvider><ImmediateActions
      channelId="fictional-action-channel"
      streamState="online"
      role="broadcaster"
      modules={[{ id: "clips", enabled: true }, ...(state === "disabled" ? [{ id: "blitz_round", enabled: false }] : [])]}
    /></UiProvider>);

    expect(screen.queryByRole("button", { name: blitzActionTexts.name[dashboardLanguage()] })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".live-action")).toHaveLength(1);
    expect(container.querySelector(".live-cockpit-actions__count")).toHaveTextContent(dashboardTexts().streamManager.actionCount(1));
    expect(requests).not.toHaveBeenCalled();
  });

  it("removes the action when its module is disabled [protects=enabled Blitz displays its running-round lock and disappears immediately on disable; fails_when=the enabled lock is missing or disabling leaves a counted action; no_claim=does not verify DO round state or network authorization]", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ reason: "round_running" }))));
    const view = (enabled: boolean) => <UiProvider><ImmediateActions
      channelId="fictional-action-channel"
      streamState="online"
      role="broadcaster"
      modules={[{ id: "blitz_round", enabled }]}
    /></UiProvider>;
    const { container, rerender } = renderWithQuery(view(true));
    const action = await screen.findByRole("button", { name: blitzActionTexts.name[dashboardLanguage()] });
    await waitFor(() => { expect(action).toHaveTextContent(blitzActionTexts.roundRunning[dashboardLanguage()]); });
    expect(action).toBeDisabled();
    rerender(view(false));
    expect(screen.queryByRole("button", { name: blitzActionTexts.name[dashboardLanguage()] })).not.toBeInTheDocument();
    expect(container.querySelector(".live-cockpit-actions__count")).toHaveTextContent(dashboardTexts().streamManager.actionCount(0));
  });
});
