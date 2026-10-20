import { useEffect, useMemo, useState, type ReactElement } from "react";

import { calculateSlotPayoutRateForDraft, formatSlotPayoutRate } from "../domain/payout-rate";
import { DEFAULT_EMOTE_SLOT_SETTINGS, type EmoteSlotSettings, type EmoteSlotSymbol } from "../contracts";
import { isSevenTvSymbolMissing } from "../domain/seven-tv";
import { emoteSlotsCatalog } from "../locale";
import { emoteSlotTemplateMessages } from "./locale";
import { Button, Dialog, FieldError, GroupedPicker, Icon, NativeRadio, StatusLed, TemplateTextField, UnitInput, type GroupedPickerEntry, type GroupedPickerGroup } from "../../../dashboard/ui";

import "./slot-fields.css";

interface SlotEmote {
  source: "emoji" | "twitch" | "seven_tv";
  code: string;
  twitchId?: string;
  sevenTvId?: string;
  name: string;
  imageUrl?: string;
}

interface SlotEmoteResponse {
  emoji: { items: SlotEmote[] };
  twitch: { status: "ok" | "reconnect_required" | "unavailable"; items: SlotEmote[] };
  sevenTv?: { status: "ok" | "no_account" | "unavailable"; setName: string | null; items: SlotEmote[] };
}

const isSlotEmote = (value: unknown): value is SlotEmote => {
  if (typeof value !== "object" || value === null) return false;
  const emote = value as Record<string, unknown>;
  return (emote.source === "emoji" || emote.source === "twitch" || emote.source === "seven_tv") && typeof emote.code === "string" &&
    typeof emote.name === "string" && (emote.twitchId === undefined || typeof emote.twitchId === "string") &&
    (emote.sevenTvId === undefined || typeof emote.sevenTvId === "string") &&
    (emote.imageUrl === undefined || typeof emote.imageUrl === "string");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSlotEmoteResponse = (value: unknown): value is SlotEmoteResponse => {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  if (typeof response.emoji !== "object" || response.emoji === null || typeof response.twitch !== "object" || response.twitch === null) return false;
  const emoji = response.emoji as Record<string, unknown>;
  const twitch = response.twitch as Record<string, unknown>;
  const sevenTv = response.sevenTv;
  return Array.isArray(emoji.items) && emoji.items.every(isSlotEmote) && Array.isArray(twitch.items) && twitch.items.every(isSlotEmote) &&
    (twitch.status === "ok" || twitch.status === "reconnect_required" || twitch.status === "unavailable") &&
    (sevenTv === undefined || isRecord(sevenTv) &&
      (sevenTv.status === "ok" || sevenTv.status === "no_account" || sevenTv.status === "unavailable") &&
      (sevenTv.setName === null || typeof sevenTv.setName === "string") && Array.isArray(sevenTv.items) && sevenTv.items.every(isSlotEmote));
};

interface SlotFieldContext {
  channelId: string;
  language: "de" | "en";
  viewerIsBot?: boolean;
  rateLocked?: boolean;
  rateLockReason?: string;
  lastTouchedField?: string;
}

const copyFor = (language: "de" | "en") => emoteSlotsCatalog[language].panel;

const safeSymbolSettings = (value: unknown): EmoteSlotSettings | null => {
  if (typeof value !== "object" || value === null || !("symbols" in value)) return null;
  return value as EmoteSlotSettings;
};

const updateSymbol = (
  settings: EmoteSlotSettings,
  index: number,
  next: Partial<EmoteSlotSymbol>,
): EmoteSlotSettings => ({
  ...settings,
  symbols: settings.symbols.map((symbol, row) => row === index ? { ...symbol, ...next } : symbol),
});

const pickerMessages = (language: "de" | "en") => {
  const copy = copyFor(language);
  return {
    title: copy.picker.title,
    searchLabel: copy.picker.searchLabel,
    closeLabel: copy.picker.closeLabel,
    noResults: copy.picker.noResults,
    keyHints: { navigate: copy.picker.navigate, choose: copy.picker.choose, close: copy.picker.close },
  };
};

const statusLine = (
  status: SlotEmoteResponse["twitch"]["status"] | "loading",
  count: number,
  language: "de" | "en",
  group: "emoji" | "twitch" = "twitch",
  onReconnect: () => void = () => undefined,
): ReactElement => {
  const copy = copyFor(language);
  const text = status === "loading" ? copy.loadingEmotes
    : status === "unavailable" ? copy.emotesUnavailable
      : status === "reconnect_required" ? copy.emotesReconnect
        : copy[`${group === "emoji" ? "countAvailable" : "emotesAvailable"}${new Intl.PluralRules(language).select(count) === "one" ? "One" : ""}`].replace("{count}", String(count));
  return <span className="slot-picker-status" aria-live="polite">
    <span>{text}</span>
    {status === "reconnect_required" ? <Button variant="subtle" size="compact" onClick={onReconnect}>{copy.reconnect}</Button> : null}
  </span>;
};

const SlotEmoteImage = ({ src, code, picker = false }: { src: string | null; code: string; picker?: boolean }): ReactElement => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return src === null || src === failedUrl
    ? <span className={`slot-symbol-placeholder${picker ? " slot-picker-emote" : ""}`} aria-hidden="true" title={code}>{code}</span>
    : <img className={picker ? "slot-picker-emote" : undefined} src={src} alt="" onError={() => { setFailedUrl(src); }} />;
};

const reelImageUrl = (symbol: EmoteSlotSymbol, emotes: SlotEmoteResponse | null): string | null => {
  if (symbol.source === "twitch" && symbol.twitchId !== undefined) {
    return emotes?.twitch.items.find((item) => item.twitchId === symbol.twitchId)?.imageUrl ??
      `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(symbol.twitchId)}/default/dark/1.0`;
  }
  if (symbol.source === "seven_tv" && symbol.sevenTvId !== undefined) {
    if (emotes?.sevenTv !== undefined && emotes.sevenTv.status !== "unavailable" && isSevenTvSymbolMissing(symbol, emotes.sevenTv.items)) return null;
    return emotes?.sevenTv?.items.find((item) => item.sevenTvId === symbol.sevenTvId)?.imageUrl ??
      `https://cdn.7tv.app/emote/${encodeURIComponent(symbol.sevenTvId)}/2x.webp`;
  }
  return null;
};

export function SlotReelTable({
  settings,
  onChange,
  disabled,
  readOnly,
  error,
  value,
  context,
  label,
}: {
  settings: EmoteSlotSettings;
  onChange: (value: unknown) => void;
  disabled: boolean;
  readOnly: boolean;
  error?: string;
  value: unknown;
  context?: unknown;
  label: string;
}): ReactElement | null {
  const parsedSettings = safeSymbolSettings(settings);
  const parsedContext = context as SlotFieldContext | undefined;
  const language = parsedContext?.language ?? "de";
  const copy = copyFor(language);
  const [emotes, setEmotes] = useState<SlotEmoteResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [pickerRow, setPickerRow] = useState<number | null>(null);
  const [reconnectDialogOpen, setReconnectDialogOpen] = useState(false);
  const [reconnectAfterPickerClose, setReconnectAfterPickerClose] = useState(false);
  useEffect(() => {
    let active = true;
    const channelId = parsedContext?.channelId;
    if (channelId === undefined) {
      return () => { active = false; };
    }
    void fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/emote_slots/emotes`, { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("emotes_unavailable");
        const result: unknown = await response.json();
        if (!isSlotEmoteResponse(result)) throw new Error("emotes_invalid_response");
        return result;
      })
      .then((result) => { if (active) setEmotes(result); })
      .catch(() => { if (active) setUnavailable(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [parsedContext?.channelId]);

  const rate = useMemo(() => calculateSlotPayoutRateForDraft(parsedSettings ?? DEFAULT_EMOTE_SLOT_SETTINGS), [parsedSettings]);
  if (parsedSettings === null || !Array.isArray(value)) return null;
  const emojiEntries: GroupedPickerEntry<SlotEmote>[] = (emotes?.emoji.items ?? []).map((emote) => ({
    id: emote.code,
    label: emote.name,
    searchText: emote.code,
    icon: <span className="slot-picker-emoji" aria-hidden="true">{emote.code}</span>,
    value: emote,
  }));
  const twitchEntries: GroupedPickerEntry<SlotEmote>[] = (emotes?.twitch.items ?? []).map((emote) => ({
    id: emote.twitchId ?? emote.code,
    label: emote.name,
    searchText: emote.code,
    icon: emote.imageUrl === undefined ? <Icon name="styleFont" /> : <SlotEmoteImage src={emote.imageUrl} code={emote.code} picker />,
    value: emote,
  }));
  const sevenTvEntries: GroupedPickerEntry<SlotEmote>[] = [];
  const seenSevenTvPairs = new Set<string>();
  for (const emote of emotes?.sevenTv?.items ?? []) {
    const id = emote.sevenTvId === undefined ? emote.code : `${emote.sevenTvId}:${emote.code}`;
    if (seenSevenTvPairs.has(id)) continue;
    seenSevenTvPairs.add(id);
    sevenTvEntries.push({
      id,
      label: emote.name,
      searchText: emote.code,
      icon: emote.imageUrl === undefined ? <Icon name="styleFont" /> : <SlotEmoteImage src={emote.imageUrl} code={emote.code} picker />,
      value: emote,
    });
  }
  const requestReconnect = (): void => {
    setReconnectAfterPickerClose(true);
    setPickerRow(null);
  };
  const handlePickerCloseComplete = (): void => {
    if (!reconnectAfterPickerClose) return;
    setReconnectAfterPickerClose(false);
    setReconnectDialogOpen(true);
  };
  const sevenTvStatusText = parsedContext?.channelId === undefined || unavailable || emotes?.sevenTv?.status === "unavailable"
    ? copy.sevenTvUnavailable
    : loading ? copy.sevenTvLoading
      : emotes?.sevenTv?.status === "no_account" ? copy.sevenTvNoAccount
        : emotes?.sevenTv?.status === "ok" ? copy.sevenTvActiveSet(emotes.sevenTv.setName ?? "7TV")
          : copy.sevenTvUnavailable;
  const sevenTvStatus = <span className="slot-picker-status slot-picker-status--seven-tv" aria-live="polite">
    <span title={sevenTvStatusText}>{sevenTvStatusText}</span>
    <span className="slot-picker-status__hint">{copy.sevenTvChatHint}</span>
  </span>;
  const groups: GroupedPickerGroup<SlotEmote>[] = [
    { id: "emoji", label: copy.emoji, entries: emojiEntries, footer: statusLine("ok", emojiEntries.length, language, "emoji") },
    {
      id: "twitch",
      label: copy.twitch,
      entries: twitchEntries,
      footer: statusLine(parsedContext?.channelId === undefined || unavailable ? "unavailable" : loading ? "loading" : emotes?.twitch.status ?? "unavailable", twitchEntries.length, language, "twitch", requestReconnect),
    },
    {
      id: "seven_tv",
      label: copy.sevenTv,
      entries: sevenTvEntries,
      footer: <span aria-hidden="true" />,
    },
  ];
  const status = rate === null ? "off" : rate.status === "locked" ? "error" : rate.status === "warning" ? "warn" : "ok";
  const rateStatus = rate === null ? "invalid" : rate.status;
  const rateLabel = rate === null ? copy.quoteInvalid : rate.status === "locked" ? copy.quoteLocked : rate.status === "warning" ? copy.quoteWarning : copy.quoteTarget;
  const choose = (index: number, entry: GroupedPickerEntry<SlotEmote>): void => {
    if (entry.value === undefined) return;
    const nextSymbol = entry.value;
    onChange(updateSymbol(parsedSettings, index, {
      source: nextSymbol.source,
      code: nextSymbol.code,
      twitchId: nextSymbol.twitchId,
      sevenTvId: nextSymbol.sevenTvId,
      name: nextSymbol.name,
    }).symbols);
    setPickerRow(null);
  };
  const numberValue = (value: unknown, onValue: (next: number | "") => void, ariaLabel: string, min: number, max: number, error: string | undefined): ReactElement =>
    <UnitInput
      label={copy.weight}
      ariaLabel={ariaLabel}
      value={typeof value === "number" && Number.isFinite(value) ? value : ""}
      onChange={onValue}
      min={min}
      max={max}
      step={1}
      clampOnBlur={false}
      {...(error === undefined ? {} : { error })}
      disabled={disabled || readOnly}
      id={`slot-number-${ariaLabel.replace(/\s+/gu, "-")}`}
    />;
  const numericError = (value: unknown, min: number, max: number, message: string): string | undefined =>
    typeof value !== "number" || !Number.isInteger(value) || value < min || value > max ? message : undefined;
  const updateNumber = (index: number, key: "weight" | "triple", next: number | ""): void => {
    onChange(parsedSettings.symbols.map((symbol, row) => row === index ? { ...symbol, [key]: next } : symbol));
  };

  return <div className="slot-reel-field" data-testid="slot-reel-field">
    <div className="slot-reel-scroll">
      <div role="radiogroup" aria-label={copy.jackpotSymbol}>
      <table className="slot-reel-table" aria-label={label}>
        <thead><tr>
          <th scope="col">{copy.symbol}</th><th scope="col">{copy.source}</th><th scope="col">{copy.weight}</th>
          <th scope="col">{copy.triple}</th><th scope="col">{copy.jackpotRow}</th><th scope="col"><span className="slot-visually-hidden">{copy.chooseSymbol}</span></th>
        </tr></thead>
        <tbody>{parsedSettings.symbols.map((symbol, index) => <tr key={symbol.id}>
          <td><span className="slot-symbol">
            {symbol.source === "emoji" ? <span className="slot-symbol-glyph" aria-hidden="true">{symbol.code}</span>
              : <SlotEmoteImage src={reelImageUrl(symbol, emotes)} code={symbol.code} />}
            <span className="slot-symbol-copy">
              <span className="slot-symbol-name">{symbol.name}</span>
              <span className="slot-symbol-missing" aria-live="polite">{symbol.source === "seven_tv" && emotes?.sevenTv !== undefined && emotes.sevenTv.status !== "unavailable" &&
                isSevenTvSymbolMissing(symbol, emotes.sevenTv.items) ? copy.sevenTvMissing : "\u00a0"}</span>
            </span>
          </span></td>
          <td><span className="slot-source-badge">{symbol.source === "emoji" ? copy.emoji : symbol.source === "twitch" ? copy.twitch : copy.sevenTv}</span></td>
          <td>{numberValue(symbol.weight, (next) => updateNumber(index, "weight", next),
            copy.weightAria.replace("{name}", symbol.name), 1, 99, numericError(symbol.weight, 1, 99, copy.weightError))}</td>
          <td>{symbol.isJackpot ? <span className="slot-jackpot-row">{copy.jackpotRow}</span> : <div className="slot-multiplier"><span aria-hidden="true">×</span>{numberValue(symbol.triple,
            (next) => updateNumber(index, "triple", next), copy.tripleAria.replace("{name}", symbol.name), 2, 500, numericError(symbol.triple, 2, 500, copy.tripleError))}</div>}</td>
          <td><NativeRadio className="slot-jackpot-radio" name="slot-jackpot-symbol" value={symbol.id}
            checked={symbol.isJackpot} disabled={disabled || readOnly}
            onChange={() => onChange(parsedSettings.symbols.map((item) => item.id === symbol.id
              // The jackpot row hides its multiplier, so an invalid one would lock save invisibly.
              ? { ...item, isJackpot: true, triple: numericError(item.triple, 2, 500, "") === undefined ? item.triple : 2 }
              : { ...item, isJackpot: false }))}
            ariaLabel={copy.jackpotAria.replace("{name}", symbol.name)} /></td>
          <td><GroupedPicker
            groups={groups}
            footer={sevenTvStatus}
            messages={pickerMessages(language)}
            opened={pickerRow === index}
            onOpenedChange={(opened) => setPickerRow(opened ? index : null)}
            onCloseComplete={handlePickerCloseComplete}
            onSelect={(entry) => choose(index, entry)}
            disabled={disabled || readOnly}
            trigger={<Button variant="neutral" className="slot-symbol-trigger" ariaLabel={`${copy.chooseSymbol}: ${symbol.name}`} disabled={disabled || readOnly}>{copy.chooseSymbol}</Button>}
          /></td>
        </tr>)}</tbody>
      </table>
      </div>
    </div>
    <div className="slot-rate-line" data-status={rateStatus}>
      <span>{copy.quote} <span className="slot-rate-value">{rate === null ? "–" : formatSlotPayoutRate(rate, language)}</span></span>
      <StatusLed state={status} label={rateLabel} />
    </div>
    <FieldError message={rate?.status === "locked" && parsedContext?.lastTouchedField === "symbols" ? copy.quoteFieldError : error} />
    <Dialog opened={reconnectDialogOpen} title={copy.reconnectDialogTitle} onClose={() => setReconnectDialogOpen(false)}>
      <p>{copy.reconnectDialogDescription}</p>
      {parsedContext?.viewerIsBot === true ? <div className="slot-reconnect-dialog__actions">
        <Button variant="primary" onClick={() => { window.location.href = "/auth/bot/login"; }}>{copy.reconnectDialogAuthorize}</Button>
      </div> : null}
    </Dialog>
  </div>;
}

// Rounds to whole basis points; excess precision (7.001 %) stays fractional so the integer schema rejects it.
const percentToBasisPoints = (percent: number): number => {
  const scaled = percent * 100;
  const rounded = Math.round(scaled);
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
};

export function SlotShareField({
  settings,
  onChange,
  disabled,
  readOnly,
  label,
  context,
  error,
}: {
  settings: EmoteSlotSettings;
  onChange: (value: unknown) => void;
  disabled: boolean;
  readOnly: boolean;
  label: string;
  context?: unknown;
  error?: string;
}): ReactElement {
  const language = (context as SlotFieldContext | undefined)?.language ?? "de";
  const copy = copyFor(language);
  const value = typeof settings.jackpotShareBp === "number" ? settings.jackpotShareBp / 100 : "";
  const rate = calculateSlotPayoutRateForDraft(settings);
  const rateLocked = rate?.status === "locked";
  const fieldError = rateLocked && (context as SlotFieldContext | undefined)?.lastTouchedField === "jackpotShareBp"
    ? copy.quoteFieldError
    : error;
  return <UnitInput
    id="slot-jackpot-share"
    label={label}
    ariaLabel={label}
    value={value}
    onChange={(next) => { onChange(next === "" ? "" : percentToBasisPoints(next)); }}
    min={0}
    max={20}
    step={0.01}
    clampOnBlur={false}
    unit="%"
    hint={copy.share}
    {...(fieldError === undefined ? {} : { error: fieldError })}
    disabled={disabled || readOnly}
  />;
}

export function SlotTextsField({
  settings,
  onChange,
  disabled,
  readOnly,
  error,
  context,
}: {
  settings: EmoteSlotSettings;
  onChange: (value: unknown) => void;
  disabled: boolean;
  readOnly: boolean;
  error?: string;
  context?: unknown;
}): ReactElement {
  const language = (context as SlotFieldContext | undefined)?.language ?? "de";
  const copy = copyFor(language);
  const sampleValues = language === "de" ? {
    user: "nachtfalke", "slot.symbols": "🍒 | 🍒 | 💎", "slot.net": "+50", "slot.balance": "200",
    "slot.jackpot": "1.003", "slot.payout": "50", "slot.stake": "50",
  } : {
    user: "sampleviewer", "slot.symbols": "🍒 | 🍒 | 💎", "slot.net": "+50", "slot.balance": "200",
    "slot.jackpot": "1,003", "slot.payout": "50", "slot.stake": "50",
  };
  const variableNames = ["user", "slot.symbols", "slot.net", "slot.balance", "slot.jackpot", "slot.payout", "slot.stake"] as const;
  const variables = variableNames.map((name) => ({
    name,
    label: copy.variables[name === "user" ? "user" : name.slice("slot.".length) as keyof typeof copy.variables],
    description: copy.variables[name === "user" ? "user" : name.slice("slot.".length) as keyof typeof copy.variables],
    sample: sampleValues[name],
    group: "event" as const,
    kind: "module" as const,
  }));
  const preview = (template: string, kind: keyof EmoteSlotSettings["texts"]): string => template.replace(/\{([^{}]+)\}/gu, (token, name: string) => {
    const outcomes = {
      win: { "slot.symbols": "🔔 | 🔔 | 🔔", "slot.net": "+550", "slot.payout": "600" },
      loss: { "slot.symbols": "🍒 | 🍋 | 💎", "slot.net": "−50", "slot.payout": "0" },
      pair: { "slot.symbols": "🍒 | 🍒 | 💎", "slot.net": "±0", "slot.payout": "50" },
      jackpot: { "slot.symbols": "7️⃣ | 7️⃣ | 7️⃣", "slot.net": "+759", "slot.jackpot": "500" },
    };
    const sample: unknown = Reflect.get({ ...sampleValues, ...outcomes[kind] }, name);
    return typeof sample === "string" ? sample : token;
  });
  const messages = emoteSlotTemplateMessages[language];
  const fields = [
    ["win", copy.win], ["loss", copy.loss], ["pair", copy.pair], ["jackpot", copy.jackpotText],
  ] as const;
  return <div className="slot-texts-field">
    {fields.map(([kind, fieldLabel]) => <TemplateTextField
      key={kind}
      id={`slot-text-${kind}`}
      name={`texts.${kind}`}
      label={fieldLabel}
      hint=""
      value={settings.texts[kind]}
      disabled={disabled || readOnly}
      onChange={(next) => onChange({ ...settings.texts, [kind]: next })}
      maxLength={500}
      variables={variables}
      preview={(template) => preview(template, kind)}
      previewLabel={copy.preview}
      previewSpeaker={copy.previewSpeaker}
      insertVariableLabel={copy.insertVariable}
      messages={messages}
    />)}
    <FieldError message={error} />
  </div>;
}
