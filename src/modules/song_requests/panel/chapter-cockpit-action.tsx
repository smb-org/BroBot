import { useEffect, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { Button, EmptyState } from "../../../dashboard/ui";
import type { SongRequestChapter } from "../contracts";
import { request } from "./service";
import { songRequestsActionTexts } from "./action-locale";
import "./panel.css";

interface OfferedChaptersResponse {
  chapters: SongRequestChapter[];
}

interface Readiness {
  enabled: boolean;
  state: string;
  streamId: string | null;
  alsoOffline: boolean;
}

export default function SongRequestChapterCockpitAction({
  channelId,
  language,
  onReadinessChange,
  onActionExecute,
}: ModuleImmediateActionContentProperties): ReactElement {
  const text = songRequestsActionTexts[language];
  const [chapters, setChapters] = useState<readonly SongRequestChapter[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyChapterId, setBusyChapterId] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      request<Readiness>(channelId, "connection", "GET", undefined, controller.signal),
      request<OfferedChaptersResponse>(channelId, "chapters/offered", "GET", undefined, controller.signal),
    ]).then(([connection, response]) => {
      if (controller.signal.aborted) return;
      setReady(connection.enabled && (connection.state === "connected" || connection.state === "no_active_device") &&
        (connection.streamId !== null || connection.alsoOffline));
      setChapters(response.chapters);
    }).catch(() => {
      if (!controller.signal.aborted) setLoadFailed(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); };
  }, [channelId]);

  useEffect(() => {
    onReadinessChange?.(ready, loading ? text.chaptersLoading : ready ? null : text.unavailable);
  }, [ready, loading, text.chaptersLoading, text.unavailable, onReadinessChange]);

  const start = async (chapterId: string): Promise<void> => {
    if (busyChapterId !== null || !ready || onActionExecute === undefined) return;
    const form = new FormData();
    form.set("chapterId", chapterId);
    setBusyChapterId(chapterId);
    try { await onActionExecute(form); }
    finally { setBusyChapterId(null); }
  };

  return <div className="live-action-content song-requests-chapter-action">
    <div className="song-requests-chapter-action__status" role="status" aria-live="polite">
      {loading ? text.chaptersLoading : loadFailed ? text.error : " "}
    </div>
    {chapters.length === 0 && !loading && !loadFailed
      ? <EmptyState title={text.chaptersEmpty} description="" />
      : <div className="song-requests-panel__list" role="list" aria-label={text.chapterName}>
        {chapters.map((chapter) => <div className="song-requests-chapter-action__row" role="listitem" key={chapter.id}>
          <div className="song-requests-chapter-action__copy">
            <strong>{chapter.name}</strong>
            <span>{text.chapterTracks(chapter.tracks.length)}</span>
          </div>
          <Button variant="secondary" disabled={!ready || busyChapterId !== null} onClick={() => { void start(chapter.id); }}>
            {busyChapterId === chapter.id ? text.loading : text.startChapter}
          </Button>
        </div>)}
      </div>}
  </div>;
}
