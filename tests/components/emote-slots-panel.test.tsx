import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SaveStatus, UiProvider } from "../../src/dashboard/ui";
import { emoteSlotDefaultSettingsForLanguage, emoteSlotSettingsSchema } from "../../src/modules/emote_slots/contracts";
import { emoteSlotsCatalog } from "../../src/modules/emote_slots/locale";
import { emoteSlotSettingsEditorCatalog } from "../../src/modules/emote_slots/panel/locale";
import { SlotReelTable, SlotShareField } from "../../src/modules/emote_slots/panel/slot-fields";
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
  it.each([
    ["8.03", 803], ["1.1", 110], ["7", 700],
  ])("converts a %s percent jackpot share to whole basis points (protects=decimal percentages become integers the schema accepts; fails_when=floating-point residue such as 802.9999999999999 reaches the draft; no_claim=locale-specific decimal input handling of the browser)", (typed, expected) => {
    const onChange = vi.fn();
    const settings = { ...emoteSlotDefaultSettingsForLanguage("de"), jackpotShareBp: 100 };
    render(<UiProvider><SlotShareField settings={settings} onChange={onChange} disabled={false} readOnly={false} label="Share" context={{ channelId: "slot_component_demo", language: "de" }} /></UiProvider>);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Share" }), { target: { value: typed } });

    expect(onChange).toHaveBeenLastCalledWith(expected);
  });

  it("keeps excess jackpot share precision fractional so the schema rejects it (protects=7.001 percent is not silently rounded; fails_when=sub-basis-point input is rounded to an accepted integer; no_claim=the wording of the field error)", () => {
    const onChange = vi.fn();
    const settings = { ...emoteSlotDefaultSettingsForLanguage("de"), jackpotShareBp: 100 };
    render(<UiProvider><SlotShareField settings={settings} onChange={onChange} disabled={false} readOnly={false} label="Share" context={{ channelId: "slot_component_demo", language: "de" }} /></UiProvider>);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Share" }), { target: { value: "7.001" } });
    const sent = onChange.mock.lastCall?.[0] as number;

    expect(Number.isInteger(sent)).toBe(false);
    expect(emoteSlotSettingsSchema.safeParse({ ...settings, jackpotShareBp: sent }).success).toBe(false);
  });

  it("normalizes a cleared multiplier when its row becomes the jackpot (protects=selecting a row with an invalid hidden multiplier leaves a valid draft; fails_when=the hidden triple stays empty and keeps the settings invalid; no_claim=save button rendering)", () => {
    const base = emoteSlotDefaultSettingsForLanguage("de");
    const copy = emoteSlotsCatalog.de.panel;
    const first = base.symbols[0]?.name ?? "";
    const second = base.symbols[1]?.name ?? "";
    function Harness() {
      const [symbols, setSymbols] = useState(base.symbols);
      return <UiProvider>
        <SlotReelTable settings={{ ...base, symbols }} value={symbols} onChange={(next) => { setSymbols(next as typeof symbols); }}
          disabled={false} readOnly={false} label="Reels" context={{ channelId: "slot_component_demo", language: "de", lastTouchedField: "symbols" }} />
        <output data-testid="valid">{String(emoteSlotSettingsSchema.safeParse({ ...base, symbols }).success)}</output>
      </UiProvider>;
    }
    stubEmoteList();
    render(<Harness />);
    fireEvent.change(screen.getByRole("spinbutton", { name: copy.tripleAria.replace("{name}", first) }), { target: { value: "" } });
    expect(screen.getByTestId("valid")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("radio", { name: copy.jackpotAria.replace("{name}", first) }));

    expect(screen.getByTestId("valid")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("radio", { name: copy.jackpotAria.replace("{name}", second) }));
    expect(screen.getByRole("spinbutton", { name: copy.tripleAria.replace("{name}", first) })).toHaveValue(2);
  });

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

  it("shows bot reconnect instructions to channel users without exposing bot authorization (protects=channel users can find the bot-account recovery instructions without opening a bot-only route; fails_when=the picker links directly to bot authorization or omits the instructions dialog; no_claim=the bot-account OAuth flow itself)", async () => {
    const copy = emoteSlotsCatalog.de.panel;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        emoji: { items: [] },
        twitch: { status: "reconnect_required", items: [] },
      }),
    })));
    const settings = emoteSlotDefaultSettingsForLanguage("de");
    render(<UiProvider><SlotReelTable
      settings={settings}
      value={settings.symbols}
      onChange={() => undefined}
      disabled={false}
      readOnly={false}
      label={copy.ariaLabel}
      context={{ channelId: "slot_channel_user_demo", language: "de", viewerIsBot: false }}
    /></UiProvider>);

    fireEvent.click(screen.getByRole("button", { name: `${copy.chooseSymbol}: ${settings.symbols[0]?.name ?? ""}` }));
    await screen.findByText(copy.emotesReconnect);
    fireEvent.click(screen.getByRole("button", { name: copy.reconnect }));

    expect(screen.getByRole("dialog", { name: copy.reconnectDialogTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.reconnectDialogDescription)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.reconnect })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.reconnectDialogAuthorize })).not.toBeInTheDocument();
  });

  it("offers direct bot authorization only in the bot account session (protects=the existing bot-session-only authorization affordance; fails_when=ordinary sessions receive the authorization action or the bot session cannot open it; no_claim=server-side authorization guards)", async () => {
    const copy = emoteSlotsCatalog.de.panel;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        emoji: { items: [] },
        twitch: { status: "reconnect_required", items: [] },
      }),
    })));
    const settings = emoteSlotDefaultSettingsForLanguage("de");
    render(<UiProvider><SlotReelTable
      settings={settings}
      value={settings.symbols}
      onChange={() => undefined}
      disabled={false}
      readOnly={false}
      label={copy.ariaLabel}
      context={{ channelId: "slot_bot_user_demo", language: "de", viewerIsBot: true }}
    /></UiProvider>);

    fireEvent.click(screen.getByRole("button", { name: `${copy.chooseSymbol}: ${settings.symbols[0]?.name ?? ""}` }));
    await screen.findByText(copy.emotesReconnect);
    fireEvent.click(screen.getByRole("button", { name: copy.reconnect }));

    expect(screen.getByRole("button", { name: copy.reconnectDialogAuthorize })).toBeInTheDocument();
  });
});
