import { useRef, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { connectedRefetchInterval, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";
import { Badge, Button, EmptyState, LoadStateLines, ListRow, notify } from "../../../dashboard/ui";
import { songRequestQueueActionTexts } from "./queue-action-locale";
import { request } from "./service";
import "./panel.css";

interface QueueItem {
  requestId: string;
  title: string;
  spotifyUrl: string;
  artists: string[];
  requester: string;
  requestType: "vote" | "bot_points" | "free" | "channel_points";
  state: "pending_review";
  createdAt: string;
}

interface QueueRead { count: number; items: QueueItem[] }

export default function SongRequestQueueActionContent({ channelId, language, canOperate }: ModuleImmediateActionContentProperties): ReactElement {
  const labels = songRequestQueueActionTexts[language];
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queueQuery = useModuleQuery<QueueRead>(channelId, "song_requests", "queue", (signal) => request<QueueRead>(channelId, "queue", "GET", undefined, signal), {
    refetchInterval: connectedRefetchInterval(realtimeStatus === "connected", 15_000),
  });
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const pendingIdsRef = useRef(new Set<string>());

  const operate = async (requestId: string, action: "approve" | "reject"): Promise<void> => {
    if (canOperate !== true || pendingIdsRef.current.has(requestId)) return;
    pendingIdsRef.current.add(requestId);
    setPendingIds(new Set(pendingIdsRef.current));
    try {
      await request(channelId, `requests/${encodeURIComponent(requestId)}/${action}`, "POST");
    } catch {
      notify({ tone: "error", message: labels.operationFailed, scope: "song-request-queue" });
    } finally {
      try { await queueQuery.refetch(); }
      catch { /* Query error state reports the failed refresh. */ }
      pendingIdsRef.current.delete(requestId);
      setPendingIds(new Set(pendingIdsRef.current));
    }
  };

  return <section className="song-request-moderator-queue" aria-label={labels.title}>
    <header className="song-request-moderator-queue__toolbar">
      <h2>{labels.title}</h2>
      <span>{String(queueQuery.data?.count ?? 0)}</span>
    </header>
    <div className="song-request-moderator-queue__status" hidden={!queueQuery.isError} role={queueQuery.isError ? "alert" : "status"} aria-live="polite">
      {queueQuery.isError ? labels.error : queueQuery.isPending ? labels.loading : " "}
    </div>
    <div className="song-request-moderator-queue__list" aria-busy={queueQuery.isFetching}>
      {queueQuery.isPending ? <LoadStateLines rows={3} height={52} /> : null}
      {queueQuery.data !== undefined && queueQuery.data.items.length === 0 ? <EmptyState title={labels.empty} description="" /> : null}
      {(queueQuery.data?.items ?? []).map((item) => {
        const pending = pendingIds.has(item.requestId);
        return <div className="song-request-moderator-queue__entry" role="listitem" key={item.requestId} aria-busy={pending}>
          <ListRow
            href={item.spotifyUrl}
            onNavigate={() => { window.open(item.spotifyUrl, "_blank", "noopener,noreferrer"); }}
            title={item.title}
            description={`${item.artists.join(", ")} · ${item.requester}`}
            status={<Badge tone="brand">{item.requestType === "free" ? labels.free
              : item.requestType === "vote" ? labels.vote
                : item.requestType === "channel_points" ? labels.channelPoints : labels.points}</Badge>}
            action={<span className="song-request-moderator-queue__actions">
              <Button size="compact" variant="primary" disabled={!canOperate || pending} onClick={() => { void operate(item.requestId, "approve"); }}>{labels.approve}</Button>
              <Button size="compact" variant="neutral" danger="subtle" disabled={!canOperate || pending} onClick={() => { void operate(item.requestId, "reject"); }}>{labels.reject}</Button>
            </span>}
          />
          <span className="song-request-moderator-queue__pending" role="status" aria-live="polite">{pending ? labels.processing : " "}</span>
        </div>;
      })}
    </div>
  </section>;
}
