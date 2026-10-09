import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent, type ReactElement } from "react";

import type { ChannelStreamState } from "../contracts/values";
import { canManage } from "../contracts/values";
import type { PanelChannelOverview, PanelEventEntry, PanelModuleState } from "../panel-contract";
import type { ModuleImmediateActionProperties } from "../modules/contract";
import { MODULES } from "../modules/registry";
import { fetchEvents } from "./api";
import { dashboardLanguage, dashboardTexts, eventText, formatNumber, formatStreamManagerFeedTime, formatTimestamp, immediateActionUnavailableReasonText } from "./locale";
import { channelPanelTexts } from "./labels";
import { eventCause, eventDetail, eventMetadata } from "./events/model";
import { emptyEventFilter } from "./events/model";
import { useRealtimeEventFeed } from "./realtime";
import { evaluateImmediateActionAvailability } from "./immediate-action-availability";
import { Button, LoadState, notify, Popover, Skeleton } from "./ui";
import { dashboardRoutePath, type DashboardRoute } from "./router";
import { collectChannelNoticeFacts, type ChannelNoticeFact } from "./channel-health";
import { moduleName } from "./module-labels";
import { StateRow } from "./module-panels";

export const ModeratorCheckAction = ({ canCheck, checking, checkError, nextAllowedAt, urgent, onCheck, notifyFailure = true, actionLabel, checkingLabel, lockedReason }: {
  canCheck: boolean;
  checking: boolean;
  checkError: string | null;
  nextAllowedAt: string | null;
  urgent: boolean;
  onCheck: () => void;
  notifyFailure?: boolean;
  actionLabel?: string;
  checkingLabel?: string;
  lockedReason?: string;
}): ReactElement => {
  const texts = dashboardTexts();
  const [now, setNow] = useState(() => Date.now());
  const notifiedError = useRef<string | null>(null);
  const nextAllowedAtMs = nextAllowedAt === null ? null : Date.parse(nextAllowedAt);
  useEffect(() => {
    if (!notifyFailure || checkError === null) {
      notifiedError.current = null;
      return;
    }
    if (notifiedError.current === checkError) return;
    notifiedError.current = checkError;
    notify({ tone: "error", message: checkError });
  }, [checkError, notifyFailure]);
  useEffect(() => {
    if (nextAllowedAtMs === null || !Number.isFinite(nextAllowedAtMs)) return;
    const timeoutId = window.setTimeout(() => { setNow(Date.now()); }, Math.max(0, nextAllowedAtMs - Date.now()));
    return () => { window.clearTimeout(timeoutId); };
  }, [nextAllowedAtMs]);
  const cooldownActive = nextAllowedAtMs !== null && Number.isFinite(nextAllowedAtMs) && nextAllowedAtMs > now;
  return (
    <div className="header-action">
      <button className={`button moderator-check-button${urgent ? " button--primary" : ""}`} type="button" onClick={onCheck} disabled={!canCheck || checking || cooldownActive} aria-busy={checking}>
        {checking ? checkingLabel ?? texts.moderation.checkRunning : actionLabel ?? texts.moderation.checkModeratorStatus}
      </button>
      <div className="header-action__reason-slot" aria-live="polite">
        {nextAllowedAt === null ? null : <span className="muted moderator-check-time">{texts.moderation.nextCheckFrom(formatTimestamp(nextAllowedAt))}</span>}
        {!canCheck ? <span className="lock-reason">{lockedReason ?? texts.moderation.checkLocked}</span> : null}
      </div>
    </div>
  );
};

export const BroadcasterConsentAction = ({ login, needed, canRequest, reasonId = "broadcaster-consent-action-reason", actionLabel }: {
  login: string;
  needed: boolean;
  canRequest: boolean;
  reasonId?: string;
  actionLabel?: string;
}): ReactElement | null => {
  if (!needed) return null;
  const texts = channelPanelTexts();
  return (
    <div className="header-action">
      {canRequest
        ? <a className="button button--primary" href={`/auth/login?channel=${encodeURIComponent(login)}`}>{actionLabel ?? texts.requestFullConsent}</a>
        : <button className="button" type="button" disabled aria-describedby={reasonId}>{actionLabel ?? texts.requestFullConsent}</button>}
      <div className="header-action__reason-slot">{!canRequest ? <span className="lock-reason" id={reasonId}>{texts.fullConsentLocked}</span> : null}</div>
    </div>
  );
};

interface ChannelNoticeCopy {
  sentence: string;
  consequence: string;
}

const noticeCopy = (fact: ChannelNoticeFact): ChannelNoticeCopy => {
  const texts = dashboardTexts().streamManager.notices;
  switch (fact.kind) {
    case "moderator-missing": return { sentence: texts.moderatorMissingSentence, consequence: texts.moderatorMissingConsequence };
    case "bot-permissions-missing": return { sentence: texts.botPermissionsSentence, consequence: texts.botPermissionsConsequence };
    case "broadcaster-permissions-missing": return { sentence: texts.broadcasterPermissionsSentence, consequence: texts.broadcasterPermissionsConsequence };
    case "module-permissions-missing": return { sentence: texts.modulePermissionsSentence(moduleName(fact.moduleId ?? "")), consequence: texts.modulePermissionsConsequence };
    case "token-expired": return { sentence: texts.tokenExpiredSentence, consequence: texts.tokenExpiredConsequence };
    case "token-renewal-overdue": return { sentence: texts.tokenRenewalSentence, consequence: texts.tokenRenewalConsequence };
  }
};

const noticeAction = (
  fact: ChannelNoticeFact,
  channel: PanelChannelOverview,
  moderatorCheck: { status: "idle" | "loading" | "error"; error: string | null; nextAllowedAt: string | null },
  onCheckModeratorStatus: () => void,
  onNavigate: (route: DashboardRoute) => void,
): ReactElement => {
  const texts = dashboardTexts();
  const noticeTexts = texts.streamManager.notices;
  const systemRoute: DashboardRoute = { kind: "channel", channelId: channel.channelId, section: "system" };
  if (fact.kind === "moderator-missing") {
    return <ModeratorCheckAction canCheck={canManage(channel.role)} checking={moderatorCheck.status === "loading"} checkError={moderatorCheck.error} nextAllowedAt={moderatorCheck.nextAllowedAt} urgent onCheck={onCheckModeratorStatus} notifyFailure={false} actionLabel={noticeTexts.checkModerator} checkingLabel={noticeTexts.checkModeratorRunning} lockedReason={noticeTexts.checkModeratorLocked} />;
  }
  if (fact.kind === "broadcaster-permissions-missing") {
    return <BroadcasterConsentAction login={channel.login} needed canRequest={channel.role === "broadcaster"} reasonId="notice-broadcaster-consent-reason" actionLabel={noticeTexts.grantPermission} />;
  }
  if (fact.kind === "module-permissions-missing") {
    const moduleId = fact.moduleId ?? "";
    const reasonId = `stream-manager-notice-permission-reason-${moduleId}`;
    return (
      <div className="header-action">
        {channel.role === "broadcaster"
          ? <a className="button button--primary" href={`/auth/channels/${encodeURIComponent(channel.channelId)}/broadcaster-scopes/${encodeURIComponent(moduleId)}`}>{noticeTexts.grantPermission}</a>
          : <Button variant="primary" disabled describedBy={reasonId}>{noticeTexts.grantPermission}</Button>}
        {channel.role === "broadcaster" ? null : <span className="lock-reason" id={reasonId}>{texts.module.scopeConsentLocked}</span>}
      </div>
    );
  }
  return <Button onClick={() => { onNavigate(systemRoute); }}>{noticeTexts.reviewPermissions}</Button>;
};

export const ChannelNotices = ({
  channel,
  modules,
  modulesLoaded,
  loadedAt,
  moderatorCheck,
  onCheckModeratorStatus,
  onNavigate,
}: {
  channel: PanelChannelOverview;
  modules: readonly PanelModuleState[];
  modulesLoaded: boolean;
  loadedAt?: number;
  moderatorCheck: { status: "idle" | "loading" | "error"; error: string | null; nextAllowedAt: string | null };
  onCheckModeratorStatus: () => void;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement | null => {
  const texts = dashboardTexts();
  const [expanded, setExpanded] = useState(false);
  if (!modulesLoaded) return null;
  const facts = collectChannelNoticeFacts({ ...channel, modules, ...(loadedAt === undefined ? {} : { loadedAt }) });
  if (facts.length === 0) return null;
  const visible = expanded ? facts : facts.slice(0, 2);
  const status = facts.some((fact) => fact.tone === "error") ? "error" : "warning";
  const noticeTexts = texts.streamManager.notices;
  return (
    <section className="stream-manager-notices" data-status={status} aria-label={noticeTexts.title}>
      <div className="stream-manager-notices__heading">
        <h2>{noticeTexts.title} <span className="mono">{formatNumber(facts.length)}</span></h2>
        {facts.length <= 2 ? null : <Button
          variant="subtle"
          className="stream-manager-notices__toggle"
          ariaExpanded={expanded}
          ariaControls="stream-manager-notices-list"
          onClick={() => { setExpanded((current) => !current); }}
        >{expanded ? noticeTexts.showFewer : noticeTexts.showAll(formatNumber(facts.length))}</Button>}
      </div>
      <div className="stream-manager-notices__items" id="stream-manager-notices-list">
        {visible.map((fact) => {
          const copy = noticeCopy(fact);
          return <StateRow
            key={fact.id}
            label={copy.sentence}
            tone={fact.tone}
            word={fact.tone === "error" ? texts.errors.title : texts.errors.warning}
            detail={copy.consequence}
            action={noticeAction(fact, channel, moderatorCheck, onCheckModeratorStatus, onNavigate)}
          />;
        })}
      </div>
    </section>
  );
};

const lazyActions = new Map<string, LazyExoticComponent<ComponentType<ModuleImmediateActionProperties>>>();
const immediateActionModules = MODULES.filter((module) => module.immediateActions !== undefined);

const getLazyImmediateAction = (moduleId: string): LazyExoticComponent<ComponentType<ModuleImmediateActionProperties>> | null => {
  const module = MODULES.find((entry) => entry.id === moduleId);
  if (module?.immediateActions === undefined) return null;
  const cached = lazyActions.get(moduleId);
  if (cached !== undefined) return cached;
  const component = lazy(module.immediateActions.load);
  lazyActions.set(moduleId, component);
  return component;
};

/**
 * The immediate actions from Epic 4: each reports success/failure at
 * itself (inline, next to its own button), never a global toast, and each
 * guards its own in-flight request the same way `Switch`'s `pending` does.
 */
export const ImmediateActions = ({ channelId, streamState, canManage = false, modules = [], modulesLoaded = true }: { channelId: string; streamState?: ChannelStreamState | null | undefined; canManage?: boolean; modules?: readonly Pick<PanelModuleState, "id" | "enabled">[]; modulesLoaded?: boolean }): ReactElement => {
  const texts = dashboardTexts();
  const modulesById = new Map(modules.map((state) => [state.id, state]));
  const moduleCards = MODULES.flatMap((module) => {
    const state = modulesById.get(module.id);
    if (state === undefined || !state.enabled || module.immediateActions === undefined) return [];
    const ActionCard = getLazyImmediateAction(module.id);
    if (ActionCard === null) return [];
    const availability = evaluateImmediateActionAvailability(module.immediateActions.requires, streamState);
    const availabilityReason = availability.reason === null
      ? null
      : immediateActionUnavailableReasonText(availability.reason);
    return [{ id: module.id, ActionCard, availabilityReason }];
  });
  return (
    <section className="content-section" aria-label={texts.streamManager.immediateActions}>
      <div className="section-heading"><h2>{texts.streamManager.immediateActions}</h2></div>
      <div
        className="stream-manager-actions"
        role="group"
        aria-label={texts.streamManager.immediateActions}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.currentTarget.scrollBy({ left: event.key === "ArrowRight" ? 316 : -316, behavior: "smooth" });
        }}
      >
        {modulesLoaded ? moduleCards.map(({ id, ActionCard, availabilityReason }) => (
          <Suspense key={id} fallback={<div className="stream-manager-action stream-manager-action--loading" aria-hidden="true"><Skeleton rows={2} height={44} /></div>}>
            <ActionCard channelId={channelId} streamState={streamState ?? null} canManage={canManage} availabilityReason={availabilityReason} />
          </Suspense>
        )) : immediateActionModules.map((module) => (
          <div key={module.id} className="stream-manager-action stream-manager-action--loading" aria-hidden="true"><Skeleton rows={2} height={44} /></div>
        ))}
      </div>
    </section>
  );
};

/**
 * Warnings and errors only, no interaction (no row selection, no filter
 * bar) -- a glance, not the full event log. Reuses the event log's realtime
 * feed and refreshes its first page when a new event arrives.
 */
export const WarningsAndErrorsFeed = ({ channelId, onNavigate }: { channelId: string; onNavigate?: (route: DashboardRoute) => void }): ReactElement => {
  const texts = dashboardTexts();
  const [entries, setEntries] = useState<readonly PanelEventEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const allAlertsRoute: DashboardRoute = {
    kind: "channel",
    channelId,
    section: "events",
    filters: { ...emptyEventFilter, tones: ["warning", "error"] },
  };
  const refreshFirstPage = useCallback(async (): Promise<void> => {
    try {
      const response = await fetchEvents(channelId);
      setFailed(false);
      setEntries(response.entries
        .filter((entry) => {
          const tone = eventMetadata(entry.code)?.tone;
          return tone === "warning" || tone === "error";
        })
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, 3));
    } catch {
      notify({ tone: "error", message: texts.events.connectionLost });
    }
  }, [channelId, texts.events.connectionLost]);
  const scrollToBeginning = useCallback((): void => undefined, []);
  useRealtimeEventFeed({ channelId, filters: emptyEventFilter, refresh: () => { void refreshFirstPage(); }, scrollToBeginning });

  useEffect(() => {
    const controller = new AbortController();
    fetchEvents(channelId, null, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setFailed(false);
        setEntries(response.entries
          .filter((entry) => {
            const tone = eventMetadata(entry.code)?.tone;
            return tone === "warning" || tone === "error";
          })
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
          .slice(0, 3));
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFailed(true);
        notify({ tone: "error", message: texts.events.connectionLost });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [channelId, texts.events.connectionLost]);

  return (
    <section className="content-section" aria-label={texts.streamManager.feedTitle}>
      <div className="section-heading"><h2>{texts.streamManager.feedTitle}</h2><a className="stream-manager-feed__all" href={dashboardRoutePath(allAlertsRoute)} onClick={onNavigate === undefined ? undefined : (event) => { event.preventDefault(); onNavigate(allAlertsRoute); }}>{texts.streamManager.feedAll}</a></div>
      <LoadState
        status={loading ? "loading" : failed ? "error" : entries.length === 0 ? "empty" : "success"}
        minHeight={132}
        loading={<Skeleton rows={3} height={44} />}
        empty={<p className="stream-manager-feed__empty">{texts.streamManager.feedEmpty}</p>}
        error={<Skeleton rows={3} height={44} />}
      >
        {entries.length === 0 ? null : <ul className="stream-manager-feed">
          {entries.map((entry) => {
            const label = eventText(entry.code, eventDetail(entry.detail, entry.code));
            const metadata = eventMetadata(entry.code);
            const tone = metadata?.tone === "error" ? "error" : metadata?.tone === "warning" ? "warning" : "neutral";
            const cause = eventCause(entry);
            return (
              <li key={entry.eventId} className="stream-manager-feed__item">
                <a
                  className="stream-manager-feed__row"
                  href={dashboardRoutePath(allAlertsRoute)}
                  onClick={onNavigate === undefined ? undefined : (event) => { event.preventDefault(); onNavigate(allAlertsRoute); }}
                >
                  <span className="event-chip" data-tone={tone}>{metadata?.word[dashboardLanguage()] ?? texts.events.unknown}</span>
                  <span className="stream-manager-feed__text">{label}</span>
                  <time className="stream-manager-feed__time mono" dateTime={entry.createdAt} title={entry.createdAt}>{formatStreamManagerFeedTime(entry.createdAt)}</time>
                </a>
                {cause === null ? null : (
                  <Popover triggerLabel={texts.events.showCause(label)} icon="cause">
                    <span className="event-cause">
                      <span>{cause.text}</span>
                      {cause.message === null ? null : (
                        <span className="event-cause__message">
                          {cause.messageIsFromTwitch ? texts.events.causeTwitchMessage(cause.message) : texts.events.causeDetailMessage(cause.message)}
                        </span>
                      )}
                    </span>
                  </Popover>
                )}
              </li>
            );
          })}
        </ul>}
      </LoadState>
    </section>
  );
};
