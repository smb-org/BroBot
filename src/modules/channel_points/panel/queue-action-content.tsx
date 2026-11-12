import { useMemo, useRef, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { connectedRefetchInterval, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";
import { Button, notify } from "../../../dashboard/ui";
import type { ChannelPointsQueueItem } from "../contracts";
import { channelPointsQueueErrorMessage, channelPointsQueueTexts } from "./queue-locale";
import { loadChannelPointsQueue, operateOnChannelPointsRedemption } from "./service";
import "./panel.css";

const compareQueueItems = (left: ChannelPointsQueueItem, right: ChannelPointsQueueItem): number => {
  const leftTime = Date.parse(left.redeemedAt);
  const rightTime = Date.parse(right.redeemedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return left.redeemedAt.localeCompare(right.redeemedAt) || left.redemptionId.localeCompare(right.redemptionId);
};

const formatQueueTime = (value: string, language: "de" | "en"): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(timestamp);
};

export default function ChannelPointsQueueActionContent({ channelId, language, canOperate }: ModuleImmediateActionContentProperties): ReactElement {
  const labels = channelPointsQueueTexts[language];
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queueQuery = useModuleQuery(channelId, "channel_points", "queue", (signal) => loadChannelPointsQueue(channelId, signal), {
    refetchInterval: connectedRefetchInterval(realtimeStatus === "connected", 15_000),
  });
  const items = useMemo(() => [...(queueQuery.data?.items ?? [])].sort(compareQueueItems), [queueQuery.data?.items]);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const pendingIdsRef = useRef(new Set<string>());

  const operate = async (redemptionId: string, operation: "run" | "refund"): Promise<void> => {
    if (canOperate !== true || pendingIdsRef.current.has(redemptionId)) return;
    pendingIdsRef.current.add(redemptionId);
    setPendingIds(new Set(pendingIdsRef.current));
    try {
      await operateOnChannelPointsRedemption(channelId, redemptionId, operation);
    } catch (error) {
      notify({
        tone: "error",
        message: channelPointsQueueErrorMessage(error, language),
        scope: "channel-points-queue",
      });
    } finally {
      try {
        await queueQuery.refetch();
      } catch {
        // The query error state communicates a failed refresh without leaving the row locked.
      } finally {
        pendingIdsRef.current.delete(redemptionId);
        setPendingIds(new Set(pendingIdsRef.current));
      }
    }
  };

  const failed = queueQuery.isError;
  const loading = queueQuery.isPending;

  return <section className="channel-points-queue" aria-label={labels.title}>
    <header className="channel-points-queue__toolbar">
      <h2>{labels.title}</h2>
      <span>{labels.count(queueQuery.data?.count ?? items.length)}</span>
    </header>
    <div className="channel-points-queue__status" role={failed ? "alert" : "status"} aria-live="polite">
      {failed ? labels.loadFailed : loading ? labels.loading : " "}
    </div>
    <div className="channel-points-queue__list" aria-busy={queueQuery.isFetching}>
      {items.length === 0
        ? <p className="channel-points-queue__empty">{loading ? labels.loading : failed ? labels.loadFailed : labels.empty}</p>
        : items.map((item) => {
          const pending = pendingIds.has(item.redemptionId);
          const formattedTime = formatQueueTime(item.redeemedAt, language);
          return <article
            className={`channel-points-queue__entry${pending ? " is-pending" : ""}`}
            aria-label={item.userName}
            aria-busy={pending}
            key={item.redemptionId}
          >
            <div className="channel-points-queue__identity">
              <div className="channel-points-queue__head">
                <strong className="channel-points-queue__viewer" title={item.userName}>{item.userName}</strong>
                <span className="channel-points-queue__reward" title={item.rewardTitle}>{item.rewardTitle}</span>
                <span className="channel-points-queue__time" title={item.redeemedAt}>{formattedTime}</span>
              </div>
              {item.userInput === "" ? null : <span className="channel-points-queue__input" title={item.userInput}>{item.userInput}</span>}
            </div>
            <div className="channel-points-queue__actions">
              {canOperate === true ? <>
                <Button
                  variant="primary"
                  size="compact"
                  disabled={pending}
                  onClick={() => { void operate(item.redemptionId, "run"); }}
                >{labels.run}</Button>
                <Button
                  variant="neutral"
                  size="compact"
                  disabled={pending}
                  onClick={() => { void operate(item.redemptionId, "refund"); }}
                >{labels.refund}</Button>
              </> : null}
            </div>
            <span className="channel-points-queue__pending" role="status" aria-live="polite">
              {pending ? labels.pending : " "}
            </span>
          </article>;
        })}
    </div>
  </section>;
}
