import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SaveStatus, UiProvider } from "../../src/dashboard/ui";
import { emoteSlotDefaultSettingsForLanguage } from "../../src/modules/emote_slots/contracts";
import { emoteSlotsCatalog } from "../../src/modules/emote_slots/locale";
import { emoteSlotSettingsEditorCatalog } from "../../src/modules/emote_slots/panel/locale";
import { SlotReelTable } from "../../src/modules/emote_slots/panel/slot-fields";
import type { EmoteSlotSettings } from "../../src/modules/emote_slots/contracts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stubEmoteList = (): void => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ emoji: { items: [] }, twitch: { status: "ok", items: [] } }),
  })));
};

const renderReelTable = (settings: EmoteSlotSettings) => render(<UiProvider>
  <SlotReelTable
    settings={settings}
    value={settings.symbols}
    onChange={() => undefined}
    disabled={false}
    readOnly={false}
    label={emoteSlotsCatalog.de.panel.ariaLabel}
    context={{ channelId: "slot_component_demo", language: "de", lastTouchedField: "symbols" }}
  />
</UiProvider>);

describe("emote slot settings controls", () => {
  it("exposes accessible names for reel weights, triples, and jackpot radios (protects=every reel control has a symbol-specific accessible name; fails_when=a numeric or radio input is unnamed or names the wrong row; no_claim=keyboard picker interaction)", () => {
    stubEmoteList();
    const settings = emoteSlotDefaultSettingsForLanguage("de");
    renderReelTable(settings);
    const copy = emoteSlotsCatalog.de.panel;

    expect(screen.getByRole("spinbutton", { name: copy.weightAria.replace("{name}", settings.symbols[0]?.name ?? "") })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: copy.tripleAria.replace("{name}", settings.symbols[1]?.name ?? "") })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: copy.jackpotAria.replace("{name}", settings.symbols[0]?.name ?? "") })).toHaveAttribute("type", "radio");
  });

  it("shows target, warning, and locked rate LED states without moving the table (protects=three payout-rate states and the causing-field error; fails_when=a rate is mislabeled, allowed when locked, or loses its reserved line; no_claim=page-level save lifecycle)", () => {
    stubEmoteList();
    const settings = emoteSlotDefaultSettingsForLanguage("de");
    const { container, rerender } = renderReelTable(settings);
    const rateLine = container.querySelector(".slot-rate-line");
    expect(rateLine).toHaveAttribute("data-status", "target");
    expect(container.querySelector(".status-led")).toHaveAttribute("aria-label", expect.stringContaining(emoteSlotsCatalog.de.panel.quoteTarget));

    const warningSettings = structuredClone(settings);
    warningSettings.jackpotShareBp = 0;
    warningSettings.jackpotSeed = 0;
    rerender(<UiProvider><SlotReelTable settings={warningSettings} value={warningSettings.symbols} onChange={() => undefined} disabled={false} readOnly={false} label={emoteSlotsCatalog.de.panel.ariaLabel} context={{ channelId: "slot_component_demo", language: "de", lastTouchedField: "symbols" }} /></UiProvider>);
    expect(rateLine).toHaveAttribute("data-status", "warning");
    expect(container.querySelector(".status-led")).toHaveAttribute("aria-label", expect.stringContaining(emoteSlotsCatalog.de.panel.quoteWarning));

    const lockedSettings = structuredClone(settings);
    const bell = lockedSettings.symbols[2];
    if (bell !== undefined) bell.triple = 500;
    rerender(<UiProvider><SlotReelTable settings={lockedSettings} value={lockedSettings.symbols} onChange={() => undefined} disabled={false} readOnly={false} label={emoteSlotsCatalog.de.panel.ariaLabel} context={{ channelId: "slot_component_demo", language: "de", lastTouchedField: "symbols" }} /></UiProvider>);
    expect(rateLine).toHaveAttribute("data-status", "locked");
    expect(container.querySelector(".status-led")).toHaveAttribute("aria-label", expect.stringContaining(emoteSlotsCatalog.de.panel.quoteLocked));
    expect(screen.getByText(emoteSlotsCatalog.de.panel.quoteFieldError)).toBeInTheDocument();
  });

  it("locks save with a neutral icon button and reserved reason (protects=save cannot submit above one hundred percent and exposes the lock reason; fails_when=the save remains active, loses its lock icon, or omits the reason; no_claim=server-side payout validation)", () => {
    const copy = emoteSlotSettingsEditorCatalog.de;
    const reason = emoteSlotsCatalog.de.panel.quoteLockedReason;
    render(<UiProvider><SaveStatus
      persistent
      dirty
      saveDisabled
      saveLocked
      saveTitle={reason}
      footer={reason}
      onSave={() => undefined}
      onDiscard={() => undefined}
      saveLabel={copy.saveLabel}
      discardLabel={copy.discardLabel}
      savedLabel={copy.savedLabel}
      pendingLabel={copy.pendingLabel}
    /></UiProvider>);
    const button = screen.getByRole("button", { name: copy.saveLabel });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", reason);
    expect(button.querySelector("svg")).not.toBeNull();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });
});
