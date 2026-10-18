import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";

import type { DryRunEffect, DryRunEntryReport, DryRunRequest, DryRunResponse } from "../contracts/dry-run";
import {
  dryRunChatMessage,
  fetchChannelBroadcast,
  lookupChannelGames,
  searchChannelGames,
  type PanelBroadcastGame,
} from "./api";
import { apiErrorText, dashboardTexts, type DashboardLanguage } from "./locale";
import { moduleNavigationName } from "./module-labels";
import { formatCharacterTotal } from "./ui/text-length";
import {
  Badge,
  Button,
  ChatPreview,
  ChipGroup,
  Dialog,
  Field,
  GameMultiSelect,
  Icon,
  NavigationIcon,
  SegmentChoice,
  Select,
  StatusLed,
  SwitchRow,
  TokenChip,
  ToolPage,
} from "./ui";
import "./TestAreaPage.css";

type DryRunModuleId = NonNullable<DryRunRequest["only"]>["moduleId"];
type ModuleFilter = "all" | DryRunModuleId;
type HistoryItem = { request: DryRunRequest; createdAt: string };
type ResultItem = { key: string; moduleId: string; report: DryRunEntryReport };
type ResultSnapshot = { response: DryRunResponse; request: DryRunRequest };
type StreamState = DryRunRequest["streamState"];

const HISTORY_KEY = "test-area-history";
const HISTORY_LIMIT = 10;
const DEFAULT_MESSAGE = "!dc hallo";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readHistory = (): HistoryItem[] => {
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(HISTORY_KEY) ?? "null");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item): HistoryItem[] => {
      if (!isRecord(item) || !isRecord(item.request) || typeof item.createdAt !== "string") return [];
      const request = item.request;
      if (typeof request.text !== "string" || !isRecord(request.sender) ||
          typeof request.sender.login !== "string" || !Array.isArray(request.sender.statuses) ||
          (request.streamState !== "online" && request.streamState !== "offline") ||
          typeof request.sharedChat !== "boolean") return [];
      const onlyModule = isRecord(request.only) ? request.only.moduleId : null;
      const only: DryRunRequest["only"] = onlyModule === "text_commands" || onlyModule === "faq"
        ? { moduleId: onlyModule, ...(isRecord(request.only) && typeof request.only.entryId === "string" ? { entryId: request.only.entryId } : {}) }
        : undefined;
      const game = isRecord(request.game) && typeof request.game.id === "string" && typeof request.game.name === "string"
        ? { id: request.game.id, name: request.game.name }
        : null;
      const statuses = request.sender.statuses.filter((status): status is NonNullable<DryRunRequest["sender"]["statuses"][number]> =>
        status === "subscriber" || status === "vip" || status === "moderator" || status === "broadcaster");
      return [{
        request: {
          text: request.text,
          sender: { login: request.sender.login, statuses },
          streamState: request.streamState,
          game,
          sharedChat: request.sharedChat,
          ...(only === undefined ? {} : { only }),
        },
        createdAt: item.createdAt,
      }];
    }).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
};

const badgeValues = ["subscriber", "vip", "moderator", "broadcaster"] as const;

const formatTime = (value: string, language: DashboardLanguage): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const moduleName = (id: string, labels: ReturnType<typeof dashboardTexts>, language: DashboardLanguage): string =>
  id === "text_commands" ? labels.testArea.textCommands
    : id === "faq" ? labels.testArea.faq
      : moduleNavigationName(id, language);

const resultItems = (response: DryRunResponse | null): ResultItem[] => response?.modules
  .filter((module) => module.status === "reacts" || module.status === "blocked")
  .flatMap((module) => module.entries.map((report) => ({
    key: module.moduleId + ":" + report.entry.id,
    moduleId: module.moduleId,
    report,
  }))) ?? [];

const firstBlockReason = (report: DryRunEntryReport, labels: ReturnType<typeof dashboardTexts>): string => {
  const block = report.blocks[0];
  return block === undefined ? labels.testArea.blocked : labels.testArea.blockReason(block.code, block.detail);
};

const matchLabel = (report: DryRunEntryReport, labels: ReturnType<typeof dashboardTexts>): string => {
  const match = report.match;
  if (match.kind === "command_name" || match.kind === "alias") {
    return match.kind === "command_name" ? labels.testArea.matchCommand : labels.testArea.matchAlias(match.token);
  }
  if (match.kind === "keyword") return labels.testArea.matchKeyword(match.pattern);
  return labels.testArea.matchRegex((match as Extract<DryRunEntryReport["match"], { kind: "regex" }>).pattern);
};

const firingLabel = (report: DryRunEntryReport, labels: ReturnType<typeof dashboardTexts>): string =>
  report.effects.some((effect) => effect.kind === "chat" || effect.kind === "announcement")
    ? labels.testArea.wouldReply
    : labels.testArea.wouldAct;

const highlightedText = (text: string, ranges: readonly (readonly [number, number])[]): ReactNode[] => {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [rawStart, rawEnd] of [...ranges].sort((left, right) => left[0] - right[0])) {
    const start = Math.max(cursor, Math.min(text.length, rawStart));
    const end = Math.max(start, Math.min(text.length, rawEnd));
    if (start > cursor) parts.push(text.slice(cursor, start));
    if (end > start) parts.push(<mark key={String(start) + ":" + String(end)}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
};

function ContextFields({
  labels,
  channelId,
  message,
  setMessage,
  sender,
  setSender,
  badges,
  setBadges,
  streamState,
  setStreamState,
  game,
  setGame,
  sharedChat,
  setSharedChat,
  moduleFilter,
  setModuleFilter,
  lockedModule,
  onClearFilter,
  onContextChange,
}: {
  labels: ReturnType<typeof dashboardTexts>;
  channelId: string;
  message: string;
  setMessage: (value: string) => void;
  sender: string;
  setSender: (value: string) => void;
  badges: readonly DryRunRequest["sender"]["statuses"][number][];
  setBadges: (value: readonly DryRunRequest["sender"]["statuses"][number][]) => void;
  streamState: StreamState;
  setStreamState: (value: StreamState) => void;
  game: PanelBroadcastGame | null;
  setGame: (value: PanelBroadcastGame | null) => void;
  sharedChat: boolean;
  setSharedChat: (value: boolean) => void;
  moduleFilter: ModuleFilter;
  setModuleFilter: (value: ModuleFilter) => void;
  lockedModule: DryRunModuleId | null;
  onClearFilter: () => void;
  onContextChange: () => void;
}): ReactElement {
  const texts = labels.testArea;
  const roleOptions = badgeValues.map((value) => ({ value, label: texts.badgeNames[value] }));
  const moduleOptions = [
    { value: "all", label: texts.allModules },
    { value: "text_commands", label: texts.textCommands },
    { value: "faq", label: texts.faq },
  ];
  const searchGames = useCallback((query: string) => searchChannelGames(channelId, query), [channelId]);
  const lookupGames = useCallback((ids: readonly string[]) => lookupChannelGames(channelId, ids), [channelId]);
  const updateMessage = (value: string): void => {
    onContextChange();
    setMessage(value.slice(0, 500));
  };
  const updateSender = (value: string): void => {
    onContextChange();
    setSender(value.toLowerCase().replace(/[^a-z0-9_]/gu, "").slice(0, 25));
  };
  const updateBadges = (value: readonly string[]): void => {
    onContextChange();
    setBadges(value.filter((entry): entry is DryRunRequest["sender"]["statuses"][number] =>
      badgeValues.some((badge) => badge === entry)));
  };

  return <>
    <Field
      label={texts.message}
      value={message}
      onChange={updateMessage}
      placeholder={texts.messagePlaceholder}
      autoComplete="off"
      maxLength={500}
      countWhenNearLimitOnly
      countLabel={(count, maximum) => String(count) + "/" + String(maximum)}
      mono
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
    />
    <Field
      label={texts.sender}
      hint={texts.senderHint}
      value={sender}
      onChange={updateSender}
      autoComplete="off"
      maxLength={25}
      countWhenNearLimitOnly
      countLabel={(count, maximum) => String(count) + "/" + String(maximum)}
      mono
    />
    <ChipGroup
      ariaLabel={texts.badges}
      value={null}
      onChange={() => undefined}
      selectedValues={badges}
      onSelectedValuesChange={updateBadges}
      options={roleOptions}
      className="test-area__badges"
    />
    <SegmentChoice
      label={texts.stream}
      value={streamState}
      onChange={(value) => { onContextChange(); setStreamState(value); }}
      options={[
        { value: "online", label: texts.online },
        { value: "offline", label: texts.offline },
      ]}
    />
    <GameMultiSelect
      searchGames={searchGames}
      lookupGames={lookupGames}
      value={game === null ? [] : [game]}
      onChange={(next) => { onContextChange(); setGame(next[0] ?? null); }}
      messages={texts.game}
      singleValue
      compact
    />
    <SwitchRow
      label={texts.sharedChat}
      checked={sharedChat}
      onChange={(next) => { onContextChange(); setSharedChat(next); }}
    />
    <Select
      label={texts.module}
      value={moduleFilter}
      onChange={(value) => {
        if (lockedModule !== null) return;
        onContextChange();
        setModuleFilter(value === "text_commands" || value === "faq" ? value : "all");
      }}
      options={moduleOptions}
      disabled={lockedModule !== null}
    />
    {lockedModule === null ? null : <div className="test-area__deep-link"><Badge tone="brand">{lockedModule === "faq" ? texts.faq : texts.textCommands}</Badge><Button variant="subtle" size="compact" onClick={onClearFilter}>{texts.clearEntryFilter}</Button></div>}
  </>;
}

function HistoryList({ items, labels, language, onReplay }: {
  items: readonly HistoryItem[];
  labels: ReturnType<typeof dashboardTexts>;
  language: DashboardLanguage;
  onReplay: (item: HistoryItem) => void;
}): ReactElement {
  const texts = labels.testArea;
  if (items.length === 0) return <p className="test-area__history-empty">{texts.historyEmpty}</p>;
  return <ul className="test-area__history-list">
    {items.map((item, index) => {
      const when = formatTime(item.createdAt, language);
      return <li key={item.createdAt + ":" + String(index)}>
        <button
          className="test-area__history-item"
          type="button"
          aria-label={texts.historyReplay(item.request.text, item.request.sender.login)}
          onClick={() => onReplay(item)}
        >
          <span className="test-area__history-message">{item.request.text}</span>
          <span className="test-area__history-meta"><span>{item.request.sender.login}</span><time dateTime={item.createdAt}>{when}</time></span>
          <Icon name="reload" />
        </button>
      </li>;
    })}
  </ul>;
}

function effectLabel(effect: DryRunEffect, labels: ReturnType<typeof dashboardTexts>): string {
  const texts = labels.testArea;
  switch (effect.kind) {
    case "chat": return effect.reply ? texts.replyToMessage : texts.chatEffect;
    case "announcement": return texts.announcementEffect;
    case "timeout": return texts.timeoutEffect(effect.minSeconds, effect.maxSeconds, effect.reason);
    case "shoutout": return texts.shoutoutEffect(effect.targetLogin);
    case "variable": return texts.variableEffect(effect.name, effect.from, effect.to);
    case "cooldown": return effect.scope === "user" ? texts.userCooldownEffect(effect.seconds) : texts.cooldownEffect(effect.seconds);
  }
}

function MatchExplanation({ report, message, labels }: {
  report: DryRunEntryReport;
  message: string;
  labels: ReturnType<typeof dashboardTexts>;
}): ReactElement {
  const match = report.match;
  const texts = labels.testArea;
  if (match.kind === "regex") return <div className="test-area__regex-match">
    <Badge tone="brand"><code>{match.pattern}</code></Badge>
    <p className="test-area__match-line">{highlightedText(message, match.ranges)}</p>
  </div>;
  const token = match.kind === "keyword" ? match.pattern : match.token;
  const label = match.kind === "keyword"
    ? texts.matchKeyword(match.pattern)
    : match.kind === "alias" ? texts.matchAlias(match.token) : texts.matchCommand;
  return <div className="test-area__match-line"><span>{label}</span> <TokenChip token={token} /></div>;
}

function ResultDetail({ item, message, response, labels, language, onOpenEditor }: {
  item: ResultItem;
  message: string;
  response: DryRunResponse;
  labels: ReturnType<typeof dashboardTexts>;
  language: DashboardLanguage;
  onOpenEditor?: (moduleId: DryRunModuleId, entryId: string) => void;
}): ReactElement {
  const { report, moduleId } = item;
  const texts = labels.testArea;
  const chatEffect = report.effects.find((effect): effect is Extract<DryRunEffect, { kind: "chat" | "announcement" }> =>
    effect.kind === "chat" || effect.kind === "announcement");
  const editorModuleId: DryRunModuleId | null = moduleId === "text_commands" || moduleId === "faq" ? moduleId : null;
  const muted = response.controls.muted;
  return <div className="test-area__detail-content">
    <header className="test-area__detail-head">
      <div className="test-area__detail-heading">
        <h2>{report.entry.label}</h2>
        <div className="test-area__detail-meta">
          <Badge tone="brand">{report.entry.kind === "faq_entry" ? texts.faqEntry : texts.textCommand}</Badge>
          <span>{matchLabel(report, labels)}</span>
        </div>
      </div>
      {onOpenEditor === undefined || editorModuleId === null ? null : <Button
        variant="subtle"
        size="compact"
        className="test-area__editor-button"
        onClick={() => onOpenEditor(editorModuleId, report.entry.id)}
      >{texts.openEditor}<Icon name="external" /></Button>}
    </header>
    <div className="test-area__detail-scroll">
      <section className="test-area__detail-section">
        <h3>{texts.why}</h3>
        <MatchExplanation report={report} message={message} labels={labels} />
        <p className="test-area__detail-note">{texts.syntheticSenderNote(response.sender.userId.replace(/^dry-run:/u, ""))}</p>
      </section>
      {chatEffect === undefined ? null : <section className="test-area__detail-section">
        <h3>{texts.answer}</h3>
        <ChatPreview
          label={texts.preview}
          speaker={texts.botSpeaker}
          text={chatEffect.text}
          countLabel={formatCharacterTotal(chatEffect.text.length, language)}
        />
        {muted && chatEffect.suppressedBy === "channel_muted" ? <p className="test-area__muted-note">{texts.suppressedAnswer}</p> : null}
        <div className="test-area__chat-target">
          <span>{texts.chatTarget}</span>
          <Badge>{chatEffect.postsTo === "all_shared_chats" ? texts.sharedChats : texts.thisChat}</Badge>
        </div>
      </section>}
      {report.outcome === "blocked" ? <section className="test-area__detail-section">
        <h3>{texts.blocks}</h3>
        <p className="test-area__reason"><Icon name="warning" />{firstBlockReason(report, labels)}</p>
      </section> : null}
      {report.outcome === "fires" && report.effects.length > 0 ? <section className="test-area__detail-section">
        <h3>{texts.wouldDo}</h3>
        <ul className="test-area__effect-list">
          {report.effects.map((effect, index) => <li key={effect.kind + ":" + String(index)}><Icon name="copied" />{effectLabel(effect, labels)}</li>)}
        </ul>
      </section> : null}
    </div>
  </div>;
}

export function TestAreaPage({
  channelId,
  language = "de",
  initialStreamState,
  only,
  onOpenEditor,
}: {
  channelId: string;
  language?: DashboardLanguage;
  initialStreamState?: "online" | "offline" | null;
  only?: DryRunRequest["only"];
  onOpenEditor?: (moduleId: DryRunModuleId, entryId: string) => void;
}): ReactElement {
  const labels = dashboardTexts(language);
  const texts = labels.testArea;
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [sender, setSender] = useState("viewer_42");
  const [badges, setBadges] = useState<readonly DryRunRequest["sender"]["statuses"][number][]>(["subscriber"]);
  const [streamState, setStreamState] = useState<StreamState>(initialStreamState ?? "online");
  const [game, setGame] = useState<PanelBroadcastGame | null>(null);
  const [sharedChat, setSharedChat] = useState(false);
  const [moduleFilter, setModuleFilter] = useState<ModuleFilter>(only?.moduleId ?? "all");
  const [deepLinkOnly, setDeepLinkOnly] = useState<DryRunRequest["only"]>(only);
  const [history, setHistory] = useState<HistoryItem[]>(readHistory);
  const historyRef = useRef(history);
  const [snapshot, setSnapshot] = useState<ResultSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const contextChanged = useRef(false);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    const requestController = new AbortController();
    void fetchChannelBroadcast(channelId, requestController.signal).then((broadcast) => {
      if (active && !contextChanged.current) setGame(broadcast.game);
    }).catch(() => undefined);
    return () => {
      active = false;
      requestController.abort();
    };
  }, [channelId]);

  useEffect(() => () => {
    sequence.current += 1;
    controller.current?.abort();
  }, []);

  const allRows = useMemo(() => resultItems(snapshot?.response ?? null), [snapshot]);
  const visibleRows = useMemo(() => moduleFilter === "all"
    ? allRows
    : allRows.filter((row) => row.moduleId === moduleFilter), [allRows, moduleFilter]);
  const selectedItem = visibleRows.find((row) => row.key === selectedKey)
    ?? visibleRows.find((row) => row.report.outcome === "fires")
    ?? visibleRows[0]
    ?? null;

  const updateHistory = useCallback((request: DryRunRequest): void => {
    const item = { request, createdAt: new Date().toISOString() };
    const next = [item, ...historyRef.current].slice(0, HISTORY_LIMIT);
    historyRef.current = next;
    setHistory(next);
    try {
      window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // Session storage can be unavailable in private or restricted contexts.
    }
  }, []);

  const submitRequest = async (request: DryRunRequest, record = true): Promise<void> => {
    if (record) updateHistory(request);
    const requestSequence = sequence.current + 1;
    sequence.current = requestSequence;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    setPending(true);
    setError(null);
    try {
      const response = await dryRunChatMessage(channelId, request, requestController.signal);
      if (sequence.current !== requestSequence) return;
      setSnapshot({ response, request });
      const rows = resultItems(response);
      const firstFiring = rows.find((row) => row.report.outcome === "fires");
      setSelectedKey((firstFiring ?? rows[0])?.key ?? null);
    } catch (cause) {
      if (sequence.current !== requestSequence || requestController.signal.aborted) return;
      const code = isRecord(cause) && typeof cause.code === "string" ? cause.code : null;
      setSnapshot(null);
      setSelectedKey(null);
      setError(apiErrorText(code, texts.errorDescription));
    } finally {
      if (sequence.current === requestSequence) setPending(false);
    }
  };

  const currentRequest = (): DryRunRequest => {
    const requestedOnly = deepLinkOnly ?? (moduleFilter === "all" ? undefined : { moduleId: moduleFilter });
    return {
      text: message,
      sender: { login: sender.trim() || "viewer_42", statuses: [...badges] },
      streamState,
      game: game === null ? null : { id: game.id, name: game.name },
      sharedChat,
      ...(requestedOnly === undefined ? {} : { only: requestedOnly }),
    };
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const request = currentRequest();
    if (request.text.trim().length === 0) return;
    void submitRequest(request);
  };

  const replay = (item: HistoryItem): void => {
    const request = item.request;
    contextChanged.current = true;
    setMessage(request.text);
    setSender(request.sender.login);
    setBadges(request.sender.statuses);
    setStreamState(request.streamState);
    setGame(request.game);
    setSharedChat(request.sharedChat);
    setDeepLinkOnly(request.only);
    setModuleFilter(request.only?.moduleId ?? "all");
    setMobileHistoryOpen(false);
    void submitRequest(request);
  };

  const changeModuleFilter = (value: ModuleFilter): void => {
    setDeepLinkOnly(undefined);
    setModuleFilter(value);
  };

  const response = snapshot?.response ?? null;
  const fires = visibleRows.filter((row) => row.report.outcome === "fires").length;
  const blocked = visibleRows.filter((row) => row.report.outcome === "blocked").length;
  const silentModules = response?.modules.filter((module) => module.status === "silent").map((module) => moduleName(module.moduleId, labels, language)) ?? [];
  const notTestableModules = response?.modules.filter((module) => module.status === "not_testable").map((module) => moduleName(module.moduleId, labels, language)) ?? [];
  const errorModules = response?.modules.filter((module) => module.status === "error").map((module) => moduleName(module.moduleId, labels, language)) ?? [];
  const state: "idle" | "loading" | "result" | "empty" | "error" =
    pending ? "loading" : error !== null ? "error" : response === null ? "idle" : visibleRows.length === 0 ? "empty" : "result";
  const detailMessage = snapshot?.request.text ?? message;
  const muted = response?.controls.muted === true;
  const paused = response?.controls.paused === true;
  const selectedBadges = badges.length === 0 ? texts.badgeNames.viewer : badges.map((badge) => texts.badgeNames[badge]).join(" · ");
  const contextSummary = [sender, selectedBadges, streamState === "online" ? texts.online : texts.offline, game?.name].filter(Boolean).join(" · ");
  const lockedModule = deepLinkOnly?.moduleId ?? null;
  const contextProps = {
    labels,
    channelId,
    message,
    setMessage,
    sender,
    setSender,
    badges,
    setBadges,
    streamState,
    setStreamState,
    game,
    setGame,
    sharedChat,
    setSharedChat,
    moduleFilter,
    setModuleFilter: changeModuleFilter,
    lockedModule,
    onClearFilter: () => {
      setDeepLinkOnly(undefined);
      setModuleFilter("all");
    },
    onContextChange: () => { contextChanged.current = true; },
  };

  const rowElement = (item: ResultItem): ReactElement => {
    const isBlocked = item.report.outcome === "blocked";
    const statusText = isBlocked ? texts.blocked : firingLabel(item.report, labels);
    return <button
      key={item.key}
      type="button"
      className="test-area__result-row"
      aria-current={selectedItem?.key === item.key ? "true" : undefined}
      onClick={() => {
        setSelectedKey(item.key);
        if (window.innerWidth <= 820) setMobileDetailOpen(true);
      }}
    >
      <span className="test-area__row-main">
        <span className="test-area__row-title"><Badge tone={isBlocked ? "amber" : "brand"}>{moduleName(item.moduleId, labels, language)}</Badge><strong>{item.report.entry.label}</strong></span>
        <small>{matchLabel(item.report, labels)}</small>
        {isBlocked ? <small className="test-area__row-reason">{firstBlockReason(item.report, labels)}</small> : null}
      </span>
      <span className="test-area__row-outcome">
        <StatusLed state={isBlocked ? "warn" : "ok"} label={statusText} dotOnly />
        <span>{statusText}</span>
      </span>
    </button>;
  };

  const detail = selectedItem !== null && response !== null
    ? <ResultDetail
      item={selectedItem}
      message={detailMessage}
      response={response}
      labels={labels}
      language={language}
      {...(onOpenEditor === undefined ? {} : { onOpenEditor })}
    />
    : <div className="test-area__detail-placeholder">{texts.noDetails}</div>;

  return <ToolPage
    kind="test"
    icon={<NavigationIcon kind="test" className="module-heading-glyph" />}
    title={texts.title}
    subtitle={texts.subtitle}
  >
    <div className="test-area">
      <aside className="test-area__context" aria-label={texts.context}>
        <form className="test-area__context-form" onSubmit={handleSubmit}>
          <ContextFields {...contextProps} />
          <Button type="submit" variant="primary" className="test-area__run-button" disabled={message.trim().length === 0}>
            <Icon name="tabMessages" />{texts.run}
          </Button>
        </form>
        <section className="test-area__history" aria-label={texts.history}>
          <h2>{texts.history}<span>{history.length}</span></h2>
          <HistoryList items={history} labels={labels} language={language} onReplay={replay} />
        </section>
      </aside>

      <section className="test-area__results" aria-label={texts.result} aria-busy={pending}>
        <div className="test-area__mobile-controls">
          <form className="test-area__mobile-message" onSubmit={handleSubmit}>
            <Field
              label={texts.message}
              value={message}
              onChange={(value) => { contextChanged.current = true; setMessage(value.slice(0, 500)); }}
              placeholder={texts.messagePlaceholder}
              autoComplete="off"
              maxLength={500}
              countWhenNearLimitOnly
              countLabel={(count, maximum) => String(count) + "/" + String(maximum)}
              mono
            />
            <Button type="submit" variant="primary" className="test-area__run-button" disabled={message.trim().length === 0}>
              <Icon name="tabMessages" />{texts.run}
            </Button>
          </form>
          <div className="test-area__mobile-context-summary">
            <span>{contextSummary}</span>
            <div>
              <Button variant="subtle" size="compact" onClick={() => setMobileContextOpen(true)}>{texts.editContext}</Button>
              <Button variant="subtle" size="compact" onClick={() => setMobileHistoryOpen(true)}><Icon name="clock-hour-4" />{texts.history}</Button>
            </div>
          </div>
        </div>

        <header className="test-area__results-head">
          <div className="test-area__results-title">
            <h2>{texts.result}</h2>
            <span>{response === null ? texts.resultCount(0) : texts.reactionsSummary(fires, blocked)}</span>
            {pending ? <span className="test-area__loading-label"><StatusLed state="loading" label={texts.loading} dotOnly />{texts.loading}</span> : null}
            {muted ? <Badge tone="amber">{texts.muted}</Badge> : null}
            {paused ? <Badge>{texts.paused}</Badge> : null}
          </div>
          <p className="test-area__meta-line" title={silentModules.length === 0 ? "" : silentModules.join(", ")}>
            {silentModules.length === 0 ? <span aria-hidden="true">&nbsp;</span> : texts.noReactionModules(silentModules.join(", "))}
          </p>
          <p className="test-area__meta-line" title={[...notTestableModules, ...errorModules].join(", ")}>
            {notTestableModules.length === 0 && errorModules.length === 0
              ? <span aria-hidden="true">&nbsp;</span>
              : <>{notTestableModules.length === 0 ? null : texts.noDryRunModules(notTestableModules.join(", "))}{notTestableModules.length > 0 && errorModules.length > 0 ? " · " : null}{errorModules.length === 0 ? null : texts.moduleError(errorModules.join(", "))}</>}
          </p>
        </header>
        <div className={"test-area__results-slot" + (pending && response !== null ? " is-pending" : "")} data-testid="test-area-results-slot" data-state={state} aria-busy={pending}>
          {state === "idle" ? <div className="test-area__state-slot">
            <Icon name="tabMessages" size={20} />
            <strong>{texts.idleTitle}</strong>
            <p>{texts.idleDescription}</p>
          </div> : null}
          {state === "loading" && response === null ? <div className="test-area__state-slot" role="status">
            <StatusLed state="loading" label={texts.loading} dotOnly />
            <strong>{texts.loading}</strong>
          </div> : null}
          {state === "error" ? <div className="test-area__state-slot" role="alert">
            <Icon name="warning" size={20} />
            <strong>{texts.errorTitle}</strong>
            <p>{error ?? texts.errorDescription}</p>
            <Button variant="neutral" size="compact" onClick={() => { void submitRequest(currentRequest()); }}>{texts.retry}</Button>
          </div> : null}
          {state === "empty" ? <div className="test-area__state-slot" role="status">
            <Icon name="copied" size={20} />
            <strong>{texts.emptyTitle}</strong>
            <p>{texts.emptyDescription}</p>
          </div> : null}
          {state === "result" || state === "loading" && response !== null
            ? <div className="test-area__result-scroll">{visibleRows.map(rowElement)}</div>
            : null}
        </div>
      </section>

      <aside className="test-area__detail" aria-label={texts.noDetails}>{detail}</aside>

      <Dialog
        opened={mobileContextOpen}
        title={texts.context}
        className="test-area__dialog test-area__context-dialog"
        onClose={() => setMobileContextOpen(false)}
      >
        <div className="test-area__dialog-fields"><ContextFields {...contextProps} /></div>
      </Dialog>
      <Dialog
        opened={mobileHistoryOpen}
        title={texts.history}
        className="test-area__dialog test-area__history-dialog"
        onClose={() => setMobileHistoryOpen(false)}
      >
        <HistoryList items={history} labels={labels} language={language} onReplay={replay} />
      </Dialog>
      <Dialog
        opened={mobileDetailOpen && selectedItem !== null && response !== null}
        title={selectedItem?.report.entry.label ?? texts.result}
        className="test-area__dialog test-area__detail-dialog"
        headerActions={selectedItem !== null && response !== null && onOpenEditor !== undefined &&
          (selectedItem.moduleId === "faq" || selectedItem.moduleId === "text_commands")
          ? <Button
            variant="subtle"
            size="compact"
            onClick={() => onOpenEditor(selectedItem.moduleId as DryRunModuleId, selectedItem.report.entry.id)}
          >{texts.openEditor}<Icon name="external" /></Button>
          : null}
        onClose={() => setMobileDetailOpen(false)}
      >
        {selectedItem !== null && response !== null
          ? <ResultDetail item={selectedItem} message={detailMessage} response={response} labels={labels} language={language} />
          : null}
      </Dialog>
    </div>
  </ToolPage>;
}
