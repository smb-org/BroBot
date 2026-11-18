import { useEffect, useMemo, useState, type ReactElement } from "react";

import { Button, CollectionPage, ConfirmDialog, EmptyState, Field, Icon, InspectorSection, ListRow, LoadState, LoadStateLines, SubInspector, SwitchRow, useDraft, useDraftGuard } from "../../../dashboard/ui";
import { useModuleQuery } from "../../../dashboard/data";
import { dashboardCommonTexts } from "../../../dashboard/locale";
import type { ModulePanelProperties } from "../../contract";
import type { SongRequestChapter, SongRequestChapterTrack } from "../contracts";
import { request } from "./service";
import { songRequestsPanelTexts } from "./locale";
import "./panel.css";

interface ChapterListResponse { chapters: SongRequestChapter[] }
interface SpotifyTrack { id: string; title: string; artists: readonly string[]; coverUrl: string | null; spotifyUrl: string }
interface ChapterDraft { name: string; tracks: SongRequestChapterTrack[]; offerInCockpit: boolean }
type ChapterPageLabels = (typeof songRequestsPanelTexts)["de" | "en"]["chapters"];

const blankChapter = (): SongRequestChapter => ({
  id: "new-chapter",
  channelId: "",
  name: "",
  tracks: [],
  offerInCockpit: false,
  revision: 0,
  createdAt: "",
  updatedAt: "",
});

const draftFrom = (chapter: SongRequestChapter): ChapterDraft => ({
  name: chapter.name,
  tracks: chapter.tracks.map((track) => ({ ...track, artists: [...track.artists] })),
  offerInCockpit: chapter.offerInCockpit,
});

export default function SongRequestChaptersPage(properties: ModulePanelProperties): ReactElement {
  const { channelId, canManage = false, canOperate = false } = properties;
  const language = properties.language === "en" ? "en" : "de";
  const text = songRequestsPanelTexts[language].chapters;
  const common = dashboardCommonTexts(language);
  const query = useModuleQuery<ChapterListResponse>(channelId, "song_requests", "chapters", (signal) =>
    request<ChapterListResponse>(channelId, "chapters", "GET", undefined, signal), { enabled: canManage || canOperate });
  const chapters = query.data?.chapters ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [guardSwitch, setGuardSwitch] = useState<((proceed: () => void) => void) | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SongRequestChapter | null>(null);

  // A selection that disappeared from the list resolves to null, which closes the inspector.
  const selected = selectedId === "new-chapter" ? blankChapter() : chapters.find(({ id }) => id === selectedId) ?? null;
  const changeSelection = (nextId: string | null): void => {
    const proceed = (): void => { setSelectedId(nextId); };
    if (guardSwitch === null) proceed();
    else guardSwitch(proceed);
  };
  const refresh = async (): Promise<void> => { await query.refetch(); };

  if (!canManage && !canOperate) return <div className="song-requests-panel"><EmptyState title={text.accessRequired} description="" /></div>;

  const toolbar = <>
    {canManage ? <Button variant="primary" icon="add" onClick={() => { changeSelection("new-chapter"); }}>{text.create}</Button> : null}
    <span className="song-requests-chapters__count">{text.count(chapters.length)}</span>
  </>;

  const list = query.data === undefined && query.isError ? null : chapters.length === 0
    ? <EmptyState title={text.emptyTitle} description={text.emptyDescription} />
    : <div className="song-requests-panel__list" role="list" aria-label={text.title}>
      {chapters.map((chapter) => <div role="listitem" key={chapter.id}>
        <ListRow
          href={`#${encodeURIComponent(chapter.id)}`}
          onNavigate={() => { changeSelection(chapter.id); }}
          title={chapter.name}
          description={`${text.trackCount(chapter.tracks.length)} · ${chapter.offerInCockpit ? text.offered : text.notOffered}`}
          selected={chapter.id === selectedId}
          status={null}
          action={null}
        />
      </div>)}
    </div>;

  return <div className="song-requests-panel song-requests-chapters">
    <LoadState
      variant="panel-420"
      status={query.data !== undefined ? "success" : query.isError ? "error" : "loading"}
      loading={<LoadStateLines rows={4} height={48} />}
      empty={<EmptyState title={text.emptyTitle} description={text.emptyDescription} />}
      error={<p role="alert">{text.loadError}</p>}
      queryError={{ message: text.loadError, onRetry: () => { void query.refetch(); } }}
      refreshError={query.isRefetchError}
    >
      <CollectionPage
        title={text.title}
        toolbar={toolbar}
        list={list}
        detail={selected === null ? null : <ChapterInspector
          key={selected.id}
          channelId={channelId}
          chapter={selected}
          isNew={selected.id === "new-chapter"}
          canManage={canManage}
          language={language}
          labels={text}
          onRegisterGuard={(guard) => { setGuardSwitch(() => guard); }}
          onClose={() => { changeSelection(null); }}
          onSaved={(chapter) => {
            void refresh().then(() => { setSelectedId(chapter.id); });
          }}
          onDelete={() => { setDeleteTarget(selected); }}
        />}
        detailOpen={selected !== null}
        backLabel={text.back}
        onCloseDetail={() => { changeSelection(null); }}
      />
    </LoadState>
    <ConfirmDialog opened={deleteTarget !== null} title={text.deleteTitle} description={text.deleteDescription}
      confirmLabel={text.delete} cancelLabel={common.cancel} danger
      onConfirm={() => {
        const target = deleteTarget;
        setDeleteTarget(null);
        if (target === null) return;
        void request(channelId, `chapters/${encodeURIComponent(target.id)}`, "DELETE", { revision: target.revision })
          .then(async () => { setSelectedId(null); await refresh(); })
          .catch(() => { void query.refetch(); });
      }} onCancel={() => { setDeleteTarget(null); }} />
  </div>;
}

function ChapterInspector({
  channelId,
  chapter,
  isNew,
  canManage,
  language,
  labels,
  onRegisterGuard,
  onClose,
  onSaved,
  onDelete,
}: {
  channelId: string;
  chapter: SongRequestChapter;
  isNew: boolean;
  canManage: boolean;
  language: "de" | "en";
  labels: ChapterPageLabels;
  onRegisterGuard: (guard: ((proceed: () => void) => void) | null) => void;
  onClose: () => void;
  onSaved: (chapter: SongRequestChapter) => void;
  onDelete: () => void;
}): ReactElement {
  const common = dashboardCommonTexts(language);
  const text = labels;
  const initial = useMemo(() => draftFrom(chapter), [chapter]);
  const draft = useDraft(initial);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<readonly SpotifyTrack[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "searched">("idle");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const save = async (): Promise<string | null> => {
    if (!canManage || draft.value.name.trim().length === 0 || Array.from(draft.value.name.trim()).length > 40) return text.nameInvalid;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await request<{ chapter: SongRequestChapter }>(channelId, isNew ? "chapters" : `chapters/${encodeURIComponent(chapter.id)}`, isNew ? "POST" : "PATCH", {
        ...draft.value,
        ...(isNew ? {} : { revision: chapter.revision }),
      });
      draft.accept(draftFrom(response.chapter));
      onSaved(response.chapter);
      return null;
    } catch (error) {
      const message = error instanceof Error && error.message === "song_request_chapter_conflict" ? text.conflict : text.saveError;
      setSaveError(message);
      return message;
    } finally { setSaving(false); }
  };
  const guard = useDraftGuard(draft.dirty, save, draft.reset);
  useEffect(() => { onRegisterGuard(guard.guardSwitch); return () => { onRegisterGuard(null); }; }, [guard.guardSwitch, onRegisterGuard]);

  const search = async (): Promise<void> => {
    const query = searchText.trim();
    if (query.length === 0 || searchState === "loading") return;
    setSearchState("loading");
    try {
      const response = await request<{ tracks: SpotifyTrack[] }>(channelId, `search?q=${encodeURIComponent(query)}`);
      setSearchResults(response.tracks);
      setSearchState("searched");
    } catch { setSearchState("idle"); setSaveError(text.searchError); }
  };
  const addTrack = (track: SpotifyTrack): void => {
    if (draft.value.tracks.length >= 20 || draft.value.tracks.some(({ id }) => id === track.id)) return;
    draft.setValue((value) => ({ ...value, tracks: [...value.tracks, {
      id: track.id,
      title: track.title,
      artists: [...track.artists],
      coverUrl: track.coverUrl,
    }] }));
  };
  const removeTrack = (trackId: string): void => {
    draft.setValue((value) => ({ ...value, tracks: value.tracks.filter(({ id }) => id !== trackId) }));
  };

  return <SubInspector ariaLabel={text.title} title={isNew ? text.newChapter : draft.value.name || text.untitled}
    closeLabel={common.close} onClose={() => { guard.guardSwitch(onClose); }} className="song-requests-chapter-inspector">
    <div className="song-requests-chapter-inspector__body">
      <Field label={text.name} value={draft.value.name} maxLength={40} countWhenNearLimitOnly
        countLabel={(count, max) => `${String(count)} / ${String(max)}`}
        disabled={!canManage || saving} onChange={(name) => { draft.setValue((value) => ({ ...value, name })); }} />
      <SwitchRow label={text.offerInCockpit} checked={draft.value.offerInCockpit} disabled={!canManage || saving}
        onChange={(offerInCockpit) => { draft.setValue((value) => ({ ...value, offerInCockpit })); }} />
      <InspectorSection title={text.trackPool}>
        <p className="song-requests-chapter-inspector__track-count">{text.trackCount(draft.value.tracks.length)} / 20</p>
        <form className="song-requests-panel__search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <Field label={text.search} value={searchText} disabled={!canManage || searchState === "loading"}
            onChange={setSearchText} normalize={(value) => value.slice(0, 200)} />
          <Button variant="secondary" type="submit" icon="search" ariaLabel={text.searchButton}
            disabled={!canManage || searchText.trim().length === 0 || searchState === "loading"}>{text.searchButton}</Button>
        </form>
        <div className="song-requests-chapter-inspector__message" role="status" aria-live="polite">
          {searchState === "loading" ? text.searching : saveError ?? " "}
        </div>
        <div className="song-requests-chapter-inspector__search-results" aria-live="polite">
          {searchState === "loading" ? <LoadStateLines rows={3} height={48} /> : null}
          {searchState === "searched" ? <div className="song-requests-panel__list" role="list" aria-label={text.searchResults}>
            {searchResults.map((track) => {
              const added = draft.value.tracks.some(({ id }) => id === track.id);
              return <div role="listitem" key={track.id}>
                <ListRow href={track.spotifyUrl} onNavigate={() => { window.open(track.spotifyUrl, "_blank", "noopener,noreferrer"); }}
                  icon={track.coverUrl === null ? <Icon name="music" size={20} /> : <img className="song-requests-chapter-cover" src={track.coverUrl} alt="" />}
                  title={track.title} description={track.artists.join(", ")} status={null}
                  action={<Button variant="secondary" size="compact" disabled={!canManage || added || draft.value.tracks.length >= 20}
                    onClick={() => { addTrack(track); }}>{added ? text.added : text.add}</Button>} />
              </div>;
            })}
          </div> : null}
        </div>
        <div className="song-requests-panel__list" role="list" aria-label={text.trackPool}>
          {draft.value.tracks.map((track) => <div role="listitem" key={track.id}>
            <ListRow href={`https://open.spotify.com/track/${track.id}`} onNavigate={() => { window.open(`https://open.spotify.com/track/${track.id}`, "_blank", "noopener,noreferrer"); }}
              icon={track.coverUrl === null ? <Icon name="music" size={20} /> : <img className="song-requests-chapter-cover" src={track.coverUrl} alt="" />}
              title={track.title} description={track.artists.join(", ")} status={null}
              action={<Button variant="subtle" danger="subtle" icon="remove" iconOnly size="compact" disabled={!canManage || saving}
                ariaLabel={text.removeTrack(track.title)} onClick={() => { removeTrack(track.id); }} />} />
          </div>)}
        </div>
      </InspectorSection>
      <div className="song-requests-chapter-inspector__actions">
        {canManage ? <>
          {!isNew ? <Button variant="subtle" danger="subtle" icon="remove" onClick={() => { setDeleteConfirm(true); }}>{text.delete}</Button> : null}
          <Button variant="secondary" disabled={!draft.dirty || saving} onClick={draft.reset}>{common.discard}</Button>
          <Button variant="primary" disabled={!draft.dirty || saving || draft.value.tracks.length > 20}
            onClick={() => { void save(); }}>{saving ? common.saving : common.save}</Button>
        </> : null}
      </div>
      <div className="song-requests-chapter-inspector__save-status" role="status" aria-live="polite">
        {guard.saveError ?? saveError ?? (draft.dirty ? text.unsaved : " ")}
      </div>
    </div>
    <ConfirmDialog opened={guard.confirmOpen} title={text.unsavedTitle} description={text.unsavedDescription}
      confirmLabel={common.save} cancelLabel={common.cancel} alternative={{ label: text.discardAndSwitch, onClick: guard.discardAndSwitch }}
      pending={guard.saving} onConfirm={() => { void guard.saveAndSwitch(); }} onCancel={guard.continueEditing}
      />
    <ConfirmDialog opened={deleteConfirm} title={text.deleteTitle} description={text.deleteDescription}
      confirmLabel={text.delete} cancelLabel={common.cancel} danger
      onConfirm={() => { setDeleteConfirm(false); onDelete(); }} onCancel={() => { setDeleteConfirm(false); }} />
  </SubInspector>;
}
