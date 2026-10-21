import { useEffect, useMemo, useState, type ReactElement } from "react";

import { PanelApiError } from "../contracts/panel-error";
import { canManage, hasRequiredChannelRole, type ChannelRole, type ChannelStreamState } from "../contracts/values";
import type { PanelEventEntry } from "../panel-contract";
import { MODULES } from "../modules/registry";
import type { ModuleLiveTileSnapshot } from "../modules/contract";
import { cancelVotekick, liftVotekickTimeout } from "../modules/votekick/panel/service";
import { approveChatVotingTerm, closeChatVoting, extendChatVoting } from "../modules/chat_voting/panel/service";
import { snoozeAds } from "../modules/ads/panel/service";
import { apiErrorText, dashboardCommonTexts, dashboardLanguage, dashboardTexts, eventText, formatNumber, immediateActionUnavailableReasonText } from "./locale";
import { moduleName } from "./module-labels";
import { eventDetail } from "./events/model";
import type { useEventsQuery } from "./data/lists";
import { evaluateImmediateActionAvailability } from "./immediate-action-availability";
import { immediateActionErrorFeedback } from "./immediate-action-errors";
import { adSnoozeRetryMessage } from "./ad-snooze-retry";
import { formatRelativeTime } from "./ui/format-relative-time";
import { Button, ChipGroup, ConfirmDialog, DataTable, Field, FilterBar, Icon } from "./ui";
import { AdsLiveTile, type AdsLiveSchedule } from "./AdsLiveTile";

type EventFilter = "all" | "raids" | "community" | "chat";

const eventCategory = (entry: PanelEventEntry): Exclude<EventFilter, "all"> | null => {
  if (entry.moduleId === "channel_events" && /\.raid\./u.test(entry.code)) return "raids";
  if (entry.moduleId === "channel_events" && /\.chat\.(?:sub|resub|gift_sub|community_gift|announcement)/u.test(entry.code)) return "community";
  if (entry.moduleId === "text_commands" || entry.moduleId === "chat_voting") return "chat";
  return null;
};

const raidLogin = (entry: PanelEventEntry): string | null => {
  if (entry.moduleId !== "channel_events" || !/\.raid\.incoming$/u.test(entry.code)) return null;
  const detail = eventDetail(entry.detail, entry.code);
  const source = typeof detail.source === "string" ? detail.source : null;
  const login = entry.actorLogin ?? source;
  return login !== null && /^[a-zA-Z0-9_]{1,25}$/u.test(login) ? login : null;
};

const remainingLabel = (until: string, now: number): string => {
  const seconds = Math.max(0, Math.ceil((Date.parse(until) - now) / 1_000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
};

export const LiveCockpitTiles = ({
  channelId,
  role,
  snapshots,
  failedModules,
  adsEnabled,
  loading,
  failed,
  now,
  timeZone,
  onMessage,
  onRefresh,
}: {
  channelId: string;
  role: ChannelRole;
  snapshots: readonly ModuleLiveTileSnapshot[];
  failedModules: readonly string[];
  adsEnabled: boolean;
  loading: boolean;
  failed: boolean;
  now: number;
  timeZone: string;
  onMessage: (message: string, tone?: "warning") => void;
  onRefresh: () => void;
}): ReactElement => {
  const labels = dashboardTexts().liveCockpit;
  const running = snapshots.find((snapshot) => snapshot.kind === "vote" || snapshot.kind === "votekick");
  const upcoming = snapshots
    .filter((snapshot): snapshot is Extract<ModuleLiveTileSnapshot, { kind: "upcoming" }> => snapshot.kind === "upcoming" && Date.parse(snapshot.at) > now)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .slice(0, 12);
  const adsSnapshot = snapshots.find((snapshot): snapshot is AdsLiveSchedule => snapshot.kind === "ad_schedule") ?? null;
  const adsFailed = failedModules.includes("ads");
  const recentVotekicks = snapshots.filter((snapshot): snapshot is Extract<ModuleLiveTileSnapshot, { kind: "votekick_recent" }> => snapshot.kind === "votekick_recent");
  const [busy, setBusy] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<{ id: string; target: string } | null>(null);
  const [cancelError, setCancelError] = useState<string | undefined>();
  const [liftTarget, setLiftTarget] = useState<{ id: string; target: string } | null>(null);
  const [liftError, setLiftError] = useState<string | undefined>();
  const [snoozeFeedback, setSnoozeFeedback] = useState<string | null>(null);
  const roleCanManage = hasRequiredChannelRole(role, "operator");
  const roleCanSnooze = canManage(role);

  useEffect(() => {
    if (snoozeFeedback === null) return;
    const feedback = snoozeFeedback;
    const timeout = window.setTimeout(() => {
      setSnoozeFeedback((current) => current === feedback ? null : current);
    }, 5_000);
    return () => { window.clearTimeout(timeout); };
  }, [snoozeFeedback]);

  const extendVote = async (pollId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await extendChatVoting(channelId, pollId);
      onMessage(labels.voteExtended);
      onRefresh();
    } catch (error: unknown) {
      onMessage(error instanceof PanelApiError && error.code === "chat_voting_poll_changed"
        ? labels.voteChanged : labels.voteExtensionUnavailable);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const endVote = async (pollId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await closeChatVoting(channelId, pollId);
      onMessage(labels.voteEnded);
      onRefresh();
    } catch (error: unknown) {
      onMessage(error instanceof PanelApiError && error.code === "chat_voting_poll_changed"
        ? labels.voteChanged : labels.voteEndFailed);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const approveTerm = async (pollId: string, term: string): Promise<void> => {
    if (busy || !roleCanManage) return;
    setBusy(true);
    try {
      await approveChatVotingTerm(channelId, pollId, term);
      onMessage(labels.voteTermApproved);
      onRefresh();
    } catch {
      onMessage(labels.voteTermApprovalFailed);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const doCancelVotekick = async (): Promise<void> => {
    if (cancelTarget === null || busy) return;
    setBusy(true);
    setCancelError(undefined);
    try {
      await cancelVotekick(channelId, cancelTarget.id);
      setCancelTarget(null);
      onMessage(labels.votekickCanceled);
      onRefresh();
    } catch (error: unknown) {
      if (error instanceof PanelApiError && error.code === "votekick_changed") {
        setCancelTarget(null);
        onMessage(labels.votekickChanged);
        onRefresh();
        return;
      }
      setCancelError(labels.votekickCancelFailed);
    } finally {
      setBusy(false);
    }
  };

  const doLiftVotekick = async (): Promise<void> => {
    if (liftTarget === null || busy || !roleCanManage) return;
    setBusy(true);
    setLiftError(undefined);
    try {
      await liftVotekickTimeout(channelId, liftTarget.id);
      setLiftTarget(null);
      onMessage(labels.votekickLifted);
      onRefresh();
    } catch {
      setLiftError(labels.votekickLiftFailed);
    } finally {
      setBusy(false);
    }
  };

  const doSnoozeAd = async (): Promise<void> => {
    if (busy) return;
    if (!roleCanSnooze || adsSnapshot === null || !adsSnapshot.snoozeScopeAvailable || (adsSnapshot.snoozeCount ?? 0) <= 0 || adsSnapshot.nextAdAt === null) {
      onMessage(labels.adSnoozeUnavailable);
      return;
    }
    setSnoozeFeedback(null);
    setBusy(true);
    try {
      await snoozeAds(channelId);
      onMessage(labels.adSnoozed);
      onRefresh();
    } catch (error: unknown) {
      const retryMessage = adSnoozeRetryMessage(error, timeZone, labels.adSnoozeRetryAfter);
      if (retryMessage === null) onMessage(labels.adSnoozeFailed);
      else {
        setSnoozeFeedback(retryMessage);
        onMessage(retryMessage, "warning");
      }
    } finally {
      setBusy(false);
    }
  };

  return <div className="live-cockpit__running">
    <section className="live-cockpit-reserve live-cockpit-running-tile" data-slot="running-now" aria-label={labels.runningNow}>
      <h2>{labels.runningNow}</h2>
      {running === undefined ? <p>{loading ? labels.liveDataLoading : failed ? labels.liveDataUnavailable : labels.noActionRunning}</p> : running.kind === "vote"
        ? <div className="live-vote-tile" data-testid="live-vote-tile">
          <header className="live-vote-tile__header">
            <div><span>{labels.voteType}</span><h3>{running.title?.trim() || labels.voteType}</h3></div>
            <span className="live-vote-tile__countdown mono">{labels.voteEndsIn(remainingLabel(running.closesAt, now))}</span>
          </header>
          <div className="live-vote-tile__options" aria-label={labels.voteType}>
            {running.options.map((option, index) => {
              const percent = running.totalVotes === 0 ? 0 : Math.round(option.count * 100 / running.totalVotes);
              return <div className="live-vote-tile__option" key={`${option.label}-${String(index)}`}>
                <div className="live-vote-tile__option-label"><strong>{option.label}</strong><span>{labels.voteOptionCount(formatNumber(option.count), String(percent))}</span></div>
                <div className="live-vote-tile__track"><span style={{ width: `${String(percent)}%`, ...(option.color === undefined ? {} : { backgroundColor: option.color }) }} /></div>
                {option.approved === false ? <Button size="compact" variant="subtle" disabled={busy || !roleCanManage} onClick={() => { void approveTerm(running.id, option.label); }}>{labels.approveVoteTerm(option.label)}</Button> : null}
              </div>;
            })}
          </div>
          <footer className="live-vote-tile__footer">
            <span>{labels.voteTotal(formatNumber(running.totalVotes))}</span>
            <div><Button size="compact" variant="secondary" icon="plus" disabled={busy || !roleCanManage || !running.canExtend} onClick={() => { void extendVote(running.id); }}>{labels.voteExtend}</Button>
              <Button size="compact" variant="neutral" danger disabled={busy || !roleCanManage} onClick={() => { void endVote(running.id); }}>{labels.voteEnd}</Button></div>
          </footer>
        </div>
        : <div className="live-votekick-tile" data-testid="live-votekick-tile">
          <header><div><span>{labels.votekickType}</span><h3>{running.target}</h3></div><span className="live-vote-tile__countdown mono">{labels.voteEndsIn(remainingLabel(running.endsAt, now))}</span></header>
          <p className="live-votekick-tile__votes">{labels.votekickVotes(formatNumber(running.yesVotes), formatNumber(running.noVotes), formatNumber(running.threshold))}</p>
          <div className="live-votekick-tile__actions"><Button size="compact" variant="neutral" danger disabled={busy || !roleCanManage} onClick={() => { setCancelTarget({ id: running.id, target: running.target }); setCancelError(undefined); }}>{labels.votekickCancel}</Button></div>
          <ConfirmDialog opened={cancelTarget !== null} title={labels.votekickCancelTitle} description={labels.votekickCancelDescription(cancelTarget?.target ?? running.target)} confirmLabel={labels.votekickCancel} cancelLabel={dashboardCommonTexts().cancel} onConfirm={() => { void doCancelVotekick(); }} onCancel={() => { if (!busy) setCancelTarget(null); }} pending={busy} danger {...(cancelError === undefined ? {} : { error: cancelError })} />
        </div>}
    </section>
    <AdsLiveTile ads={adsSnapshot} now={now} language={dashboardLanguage()} canManage={roleCanSnooze} moduleActive={adsEnabled}
      loading={loading && adsEnabled && !adsFailed} failed={adsFailed} actionPending={busy} snoozeFeedback={snoozeFeedback}
      onSnooze={() => { void doSnoozeAd(); }} />
    <section className="live-cockpit-reserve live-cockpit-next-tile" data-slot="next-up" aria-label={labels.nextUp}>
      <h2>{labels.recentVotekicks}</h2>
      <div className="live-cockpit-next-list live-cockpit-next-list--recent">
        {recentVotekicks.length === 0 ? <p>{loading ? labels.liveDataLoading : failed ? labels.liveDataUnavailable : labels.noRecentVotekicks}</p> : recentVotekicks.map((item) => <div className="live-cockpit-next-item" key={item.id}>
          <span className="live-cockpit-next-item__icon"><Icon name="vote" size={16} /></span>
          <span className="live-cockpit-next-item__copy"><strong>{item.target}</strong></span>
          <time className="live-cockpit-next-item__time" dateTime={item.endedAt}>{formatRelativeTime(item.endedAt, new Date(now), dashboardLanguage(), timeZone).label}</time>
          <Button size="compact" variant="neutral" disabled={busy || !roleCanManage} onClick={() => { setLiftTarget({ id: item.id, target: item.target }); setLiftError(undefined); }}>{labels.votekickLift}</Button>
        </div>)}
      </div>
      <ConfirmDialog opened={liftTarget !== null} title={labels.votekickLiftTitle} description={labels.votekickLiftDescription(liftTarget?.target ?? "")} confirmLabel={labels.votekickLift} cancelLabel={dashboardCommonTexts().cancel} onConfirm={() => { void doLiftVotekick(); }} onCancel={() => { if (!busy) setLiftTarget(null); }} pending={busy} danger {...(liftError === undefined ? {} : { error: liftError })} />
      <h2>{labels.nextUp}</h2>
      {upcoming.length === 0 ? <p>{loading ? labels.liveDataLoading : failed ? labels.liveDataUnavailable : labels.noUpcomingItems}</p> : <div className="live-cockpit-next-list">
        {upcoming.map((item) => {
          const relative = formatRelativeTime(item.at, new Date(now), dashboardLanguage(), timeZone).label;
          return <div className="live-cockpit-next-item" key={`${item.category}:${item.id}`}>
            <span className="live-cockpit-next-item__icon"><Icon name="clock-hour-4" size={16} /></span>
            <span className="live-cockpit-next-item__copy"><strong>{item.name}</strong>{item.detail === null ? null : <small>{item.detail}</small>}</span>
            <time className="live-cockpit-next-item__time" dateTime={item.at} title={new Date(item.at).toLocaleString(dashboardLanguage(), { timeZone })}>{relative}</time>
          </div>;
        })}
      </div>}
    </section>
  </div>;
};

export const LiveCockpitEventFeed = ({ channelId, role, now, timeZone, eventQuery, streamState, raidEnabled, onMessage }: {
  channelId: string;
  role: ChannelRole;
  now: number;
  timeZone: string;
  eventQuery: ReturnType<typeof useEventsQuery>;
  streamState: ChannelStreamState | null | undefined;
  raidEnabled: boolean;
  onMessage: (message: string) => void;
}): ReactElement => {
  const labels = dashboardTexts().liveCockpit;
  const common = dashboardCommonTexts();
  const [filter, setFilter] = useState<EventFilter>("all");
  const [search, setSearch] = useState("");
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const language = dashboardLanguage();
  const entries = useMemo(() => eventQuery.data?.pages.flatMap((page) => page.entries) ?? [], [eventQuery.data]);
  const query = search.trim().toLocaleLowerCase(language);
  const filtered = useMemo(() => entries.filter((entry) => {
    const category = eventCategory(entry);
    if (filter !== "all" && category !== filter) return false;
    if (query.length === 0) return true;
    const text = `${entry.actorDisplayName ?? ""} ${entry.actorLogin ?? ""} ${moduleName(entry.moduleId, language)} ${eventText(entry.code, eventDetail(entry.detail, entry.code), language)}`;
    return text.toLocaleLowerCase(language).includes(query);
  }), [entries, filter, language, query]);
  const raidAction = MODULES.find((module) => module.id === "raid")?.actions?.find((action) => action.id === "send-shoutout");
  const roleCanShoutout = raidAction !== undefined && hasRequiredChannelRole(role, raidAction.requiredRole);
  const shoutoutAvailability = evaluateImmediateActionAvailability(raidAction?.conditions ?? [], streamState);
  const shoutoutReason = !raidEnabled
    ? apiErrorText("module_disabled", labels.raidShoutoutFailed, language)
    : shoutoutAvailability.reason === null ? null : immediateActionUnavailableReasonText(shoutoutAvailability.reason, language);
  const rows = filtered.map((entry) => ({
    id: entry.eventId,
    at: new Date(entry.createdAt),
    moduleGroup: entry.moduleId,
    module: moduleName(entry.moduleId, language),
    summary: eventText(entry.code, eventDetail(entry.detail, entry.code), language),
    actor: entry.actorDisplayName ?? entry.actorLogin ?? "—",
    entry,
  }));

  const sendShoutout = async (entry: PanelEventEntry): Promise<void> => {
    if (raidAction === undefined || !raidEnabled || !shoutoutAvailability.enabled || busyEntry !== null) return;
    const login = raidLogin(entry);
    if (login === null) return;
    setBusyEntry(entry.eventId);
    try {
      const formData = new FormData();
      formData.set("login", login);
      await raidAction.execute({ channelId, language, formData });
      onMessage(`${labels.raidShoutoutSent} @${login}`);
    } catch (error: unknown) {
      onMessage(immediateActionErrorFeedback(error, "raid", labels.raidShoutoutFailed, language).message);
    } finally {
      setBusyEntry(null);
    }
  };

  return <section className="live-cockpit-reserve live-cockpit-event-feed" data-slot="events" aria-label={labels.events}>
    <header className="live-cockpit-event-feed__heading"><h2>{labels.events}</h2></header>
    <FilterBar className="live-cockpit-event-feed__filters" label={labels.eventsFilterLabel}>
      <Field className="live-cockpit-event-feed__search" variant="search" label={labels.eventsSearch} value={search} onChange={setSearch} clearLabel={common.clearSearch} placeholder={labels.eventsSearch} />
      <ChipGroup ariaLabel={labels.eventsFilterLabel} value={filter} onChange={(value) => { setFilter((value || "all") as EventFilter); }} options={[
        { value: "all", label: labels.eventsAll },
        { value: "raids", label: labels.eventsRaids },
        { value: "community", label: labels.eventsCommunity },
        { value: "chat", label: labels.eventsChat },
      ]} />
    </FilterBar>
    <div className="live-cockpit-event-feed__scroll" aria-busy={eventQuery.isFetching}>
      {eventQuery.isError ? <div className="live-cockpit-event-feed__error" role="alert">
        <p>{labels.eventsUnavailable}</p>
        <Button size="compact" variant="secondary" disabled={eventQuery.isFetching} onClick={() => { void eventQuery.refetch(); }}>{common.retry}</Button>
      </div> : eventQuery.isPending ? <div className="live-cockpit-event-feed__loading" role="status">{labels.eventsLoading}</div> : <DataTable
          ariaLabel={labels.events}
          className="event-table live-cockpit-event-feed__table"
          rows={rows}
          timeZone={timeZone}
          emptyLabel={labels.eventsEmpty}
          now={new Date(now)}
          columns={[
            { key: "event", label: dashboardTexts().events.event, render: (row) => {
              const login = raidLogin(row.entry);
              return <>
                <span className="event-label event-table__primary">
                  <span className="event-table__text" title={row.summary}>{row.summary}</span>
                  {login === null ? null : <>
                    <Button size="compact" variant="secondary"
                      disabled={!roleCanShoutout || !raidEnabled || !shoutoutAvailability.enabled || busyEntry !== null}
                      {...(shoutoutReason === null ? {} : { describedBy: `${row.entry.eventId}-raid-shoutout-reason` })}
                      onClick={() => { void sendShoutout(row.entry); }}>{labels.raidShoutout}</Button>
                    {shoutoutReason === null ? null : <span className="sr-only" id={`${row.entry.eventId}-raid-shoutout-reason`}>{shoutoutReason}</span>}
                  </>}
                </span>
                <span className="event-table__mobile-meta muted">
                  <span className="data-table__module-group" data-module-group={row.moduleGroup} aria-hidden="true" />
                  <span title={row.module}>{row.module}</span><span aria-hidden="true">·</span><span title={row.actor}>{row.actor}</span>
                </span>
              </>;
            } },
            { key: "module", label: dashboardTexts().events.module, moduleGroup: true, hideOnMobile: true, render: (row) => <span title={row.module}>{row.module}</span> },
          ]}
        />}
    </div>
    <span className="sr-only" aria-live="polite">{eventQuery.isError && entries.length > 0 ? labels.eventsUnavailable : eventQuery.isPending ? labels.eventsLoading : ""}</span>
  </section>;
};

