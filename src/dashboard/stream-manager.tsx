import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType, type LazyExoticComponent, type ReactElement } from "react";

import type { ChannelStreamState } from "../contracts/values";
import type { PanelEventEntry, PanelModuleState } from "../panel-contract";
import type { ModuleImmediateActionProperties } from "../modules/contract";
import { MODULES } from "../modules/registry";
import { fetchEvents } from "./api";
import { dashboardLanguage, dashboardTexts, eventText, formatStreamManagerFeedTime, immediateActionUnavailableReasonText } from "./locale";
import { eventCause, eventDetail, eventMetadata } from "./events/model";
import { emptyEventFilter } from "./events/model";
import { useRealtimeEventFeed } from "./realtime";
import { evaluateImmediateActionAvailability } from "./immediate-action-availability";
import { Popover } from "./ui";
import { dashboardRoutePath, type DashboardRoute } from "./router";

const lazyActions = new Map<string, LazyExoticComponent<ComponentType<ModuleImmediateActionProperties>>>();

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
export const ImmediateActions = ({ channelId, streamState, modules = [] }: { channelId: string; streamState?: ChannelStreamState | null | undefined; modules?: readonly Pick<PanelModuleState, "id" | "enabled">[] }): ReactElement => {
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
      <div className="stream-manager-actions">
        {moduleCards.map(({ id, ActionCard, availabilityReason }) => (
          <Suspense key={id} fallback={null}>
            <ActionCard channelId={channelId} streamState={streamState ?? null} availabilityReason={availabilityReason} />
          </Suspense>
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
  const allAlertsRoute: DashboardRoute = {
    kind: "channel",
    channelId,
    section: "events",
    filters: { ...emptyEventFilter, tones: ["warning", "error"] },
  };
  const refreshFirstPage = useCallback(async (): Promise<void> => {
    const response = await fetchEvents(channelId);
    setEntries(response.entries
      .filter((entry) => {
        const tone = eventMetadata(entry.code)?.tone;
        return tone === "warning" || tone === "error";
      })
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 3));
  }, [channelId]);
  const atBeginning = useCallback((): boolean => true, []);
  const scrollToBeginning = useCallback((): void => undefined, []);
  useRealtimeEventFeed({ channelId, filters: emptyEventFilter, atBeginning, refreshFirstPage, scrollToBeginning });

  useEffect(() => {
    const controller = new AbortController();
    fetchEvents(channelId, null, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setEntries(response.entries
          .filter((entry) => {
            const tone = eventMetadata(entry.code)?.tone;
            return tone === "warning" || tone === "error";
          })
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
          .slice(0, 3));
      })
      .catch(() => { if (!controller.signal.aborted) setEntries([]); });
    return () => { controller.abort(); };
  }, [channelId]);

  return (
    <section className="content-section" aria-label={texts.streamManager.feedTitle}>
      <div className="section-heading"><h2>{texts.streamManager.feedTitle}</h2><a className="stream-manager-feed__all" href={dashboardRoutePath(allAlertsRoute)} onClick={onNavigate === undefined ? undefined : (event) => { event.preventDefault(); onNavigate(allAlertsRoute); }}>{texts.streamManager.feedAll}</a></div>
      {entries.length === 0 ? (
        <p className="stream-manager-feed__empty">{texts.streamManager.feedEmpty}</p>
      ) : (
        <ul className="stream-manager-feed">
          {entries.map((entry) => {
            const label = eventText(entry.code, eventDetail(entry.detail));
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
                {cause === null ? null : <Popover triggerLabel={texts.events.showCause(label)} icon="cause">{cause}</Popover>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
