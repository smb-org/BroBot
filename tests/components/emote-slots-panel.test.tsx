import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SaveStatus, UiProvider } from "../../src/dashboard/ui";
import { emoteSlotDefaultSettingsForLanguage, emoteSlotSettingsSchema } from "../../src/modules/emote_slots/contracts";
import { emoteSlotsCatalog } from "../../src/modules/emote_slots/locale";
import { emoteSlotSettingsEditorCatalog } from "../../src/modules/emote_slots/panel/locale";
import { SlotReelTable, SlotShareField, SlotTextsField } from "../../src/modules/emote_slots/panel/slot-fields";
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

  it("keeps disabled outcome text editable and saved while hiding only its chat action switch", () => {
    const base = emoteSlotDefaultSettingsForLanguage("de");
    const settings = { ...base, texts: { ...base.texts, win: "Saved win text", winEnabled: false } };
    const onChange = vi.fn();
    const copy = emoteSlotsCatalog.de.panel;
    render(<UiProvider><SlotTextsField settings={settings} onChange={onChange} disabled={false} readOnly={false}
      context={{ channelId: "slot_component_demo", language: "de" }} /></UiProvider>);

    const toggle = screen.getByRole("switch", { name: `${copy.win}: ${copy.messageEnabledLabel}` });
    const textbox = screen.getByRole("textbox", { name: copy.win });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect((textbox as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(textbox, { target: { value: "Edited while disabled" } });

    expect(onChange).toHaveBeenLastCalledWith({ ...settings.texts, win: "Edited while disabled" });
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

  it("navigates 7TV aliases with the same emote id by their distinct codes (protects=each unique 7TV id and code pair has a unique picker identity and ArrowDown reaches every alias; fails_when=the aliases share a DOM id or keyboard navigation cannot activate the second one; no_claim=provider ordering beyond the returned alias order)", async () => {
    const copy = emoteSlotsCatalog.de.panel;
    const settings = emoteSlotDefaultSettingsForLanguage("de");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        emoji: { items: [] },
        twitch: { status: "ok", items: [] },
        sevenTv: {
          status: "ok",
          setName: "Night Shift",
          items: [
            { source: "seven_tv", code: "oldwave", sevenTvId: "emote-shared", name: "oldwave" },
            { source: "seven_tv", code: "newwave", sevenTvId: "emote-shared", name: "newwave" },
            { source: "seven_tv", code: "oldwave", sevenTvId: "emote-shared", name: "oldwave" },
          ],
        },
      }),
    })));
    renderReelTable(settings);
    fireEvent.click(screen.getByRole("button", { name: `${copy.chooseSymbol}: ${settings.symbols[0]?.name ?? ""}` }));
    const search = await screen.findByRole("combobox", { name: copy.picker.searchLabel });
    expect(screen.getAllByRole("option", { hidden: true })).toHaveLength(2);
    const oldAlias = screen.getByRole("option", { name: /oldwave/u, hidden: true });
    const newAlias = screen.getByRole("option", { name: /newwave/u, hidden: true });

    expect(oldAlias.id).not.toBe(newAlias.id);
    expect(oldAlias).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(oldAlias).toHaveAttribute("aria-selected", "false");
    expect(newAlias).toHaveAttribute("aria-selected", "true");
  });

  it("shows the missing notice and saved-code fallback after an active 7TV alias is renamed (protects=the saved id and exact code pair controls active membership and preserves the configured code for chat and reel fallback; fails_when=the same id with a new alias hides the notice or displays the renamed code; no_claim=provider state while the emote route is unavailable)", async () => {
    const copy = emoteSlotsCatalog.de.panel;
    const defaults = emoteSlotDefaultSettingsForLanguage("de");
    const symbols = defaults.symbols.map((symbol, index) => index === 0
      ? { ...symbol, source: "seven_tv" as const, code: "oldwave", sevenTvId: "emote-shared", name: "oldwave" }
      : symbol);
    const settings = { ...defaults, symbols };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        emoji: { items: [] },
        twitch: { status: "ok", items: [] },
        sevenTv: {
          status: "ok",
          setName: "Night Shift",
          items: [{ source: "seven_tv", code: "newwave", sevenTvId: "emote-shared", name: "newwave" }],
        },
      }),
    })));
    const { container } = renderReelTable(settings);

    expect(await screen.findByText(copy.sevenTvMissing)).toHaveClass("slot-symbol-missing");
    expect(container.querySelector('.slot-symbol-placeholder[title="oldwave"]')).toBeInTheDocument();
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

  it.each([
    ["de", 1, 3, "1 Symbol verfügbar", "3 Emotes verfügbar"],
    ["de", 3, 1, "3 Symbole verfügbar", "1 Emote verfügbar"],
    ["en", 1, 3, "1 symbol available", "3 emotes available"],
    ["en", 3, 1, "3 symbols available", "1 emote available"],
  ] as const)("uses singular and plural picker counts in %s for %i emoji and %i Twitch emotes (protects=footer counts read grammatically for one and many; fails_when=a count of one keeps the plural noun; no_claim=other locales' plural categories)", async (language, emojiCount, twitchCount, emojiText, twitchText) => {
    const copy = emoteSlotsCatalog[language].panel;
    const settings = emoteSlotDefaultSettingsForLanguage(language);
    const emoji = Array.from({ length: emojiCount }, (_, i) => ({ source: "emoji", code: ["🍒", "🍋", "🔔"][i], name: `Emoji ${String(i)}` }));
    const twitch = Array.from({ length: twitchCount }, (_, i) => ({ source: "twitch", code: `kappa${String(i)}`, twitchId: `t${String(i)}`, name: `kappa${String(i)}` }));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ emoji: { items: emoji }, twitch: { status: "ok", items: twitch } }),
    })));
    render(<UiProvider><SlotReelTable
      settings={settings}
      value={settings.symbols}
      onChange={() => undefined}
      disabled={false}
      readOnly={false}
      label={copy.ariaLabel}
      context={{ channelId: "slot_plural_demo", language, lastTouchedField: "symbols" }}
    /></UiProvider>);

    fireEvent.click(screen.getByRole("button", { name: `${copy.chooseSymbol}: ${settings.symbols[0]?.name ?? ""}` }));
    await screen.findByText(twitchText);
    expect(screen.getByText(emojiText)).toBeInTheDocument();
  });

  it("lists emoji picker entries without repeating the glyph as a description (protects=each emoji appears once per option; fails_when=the glyph is also rendered as secondary text; no_claim=Twitch or 7TV entry layout)", async () => {
    const copy = emoteSlotsCatalog.de.panel;
    const settings = emoteSlotDefaultSettingsForLanguage("de");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ emoji: { items: [{ source: "emoji", code: "🍒", name: "Cherry" }] }, twitch: { status: "ok", items: [] } }),
    })));
    renderReelTable(settings);
    fireEvent.click(screen.getByRole("button", { name: `${copy.chooseSymbol}: ${settings.symbols[0]?.name ?? ""}` }));
    const option = (await screen.findByText("Cherry")).closest("[role='option']");
    expect((option?.textContent ?? "").split("🍒").length).toBe(2);
  });

  it.each(["de", "en"] as const)("finds an emoji by its pasted glyph in the %s picker search (protects=the glyph stays searchable although it is not shown as a description; fails_when=searching the glyph hides the Cherry entry; no_claim=ranking or non-emoji sources)", async (language) => {
    const copy = emoteSlotsCatalog[language].panel;
    const settings = emoteSlotDefaultSettingsForLanguage(language);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ emoji: { items: [{ source: "emoji", code: "🍒", name: "Cherry" }, { source: "emoji", code: "🍋", name: "Lemon" }] }, twitch: { status: "ok", items: [] } }),
    })));
    render(<UiProvider><SlotReelTable
      settings={settings}
      value={settings.symbols}
      onChange={() => undefined}
      disabled={false}
      readOnly={false}
      label={copy.ariaLabel}
      context={{ channelId: "slot_component_demo", language, lastTouchedField: "symbols" }}
    /></UiProvider>);
    fireEvent.click(screen.getByRole("button", { name: `${copy.chooseSymbol}: ${settings.symbols[0]?.name ?? ""}` }));
    const search = await screen.findByRole("combobox", { name: copy.picker.searchLabel });
    await screen.findAllByRole("option", { hidden: true });
    fireEvent.change(search, { target: { value: "🍒" } });

    const options = screen.getAllByRole("option", { hidden: true });
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Cherry");
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
