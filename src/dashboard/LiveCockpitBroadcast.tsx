import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { canManage, type ChannelRole } from "../contracts/values";
import { PanelApiError } from "../contracts/panel-error";
import {
  fetchChannelBroadcast,
  lookupChannelGames,
  saveChannelBroadcast,
  searchChannelGames,
} from "./api";
import type { PanelBroadcastGame } from "./api";
import { dashboardCommonTexts, dashboardTexts } from "./locale";
import { queryKeys } from "./data/keys";
import { Button, Field, FormDialog, GameMultiSelect } from "./ui";

export const LiveCockpitBroadcast = ({ channelId, role, onSaved }: {
  channelId: string;
  role: ChannelRole;
  onSaved: (message: string) => void;
}): ReactElement => {
  const labels = dashboardTexts().liveCockpit;
  const common = dashboardCommonTexts();
  const queryClient = useQueryClient();
  const activeRef = useRef(true);
  const key = queryKeys.channel(channelId, "broadcast");
  const broadcast = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchChannelBroadcast(channelId, signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const [opened, setOpened] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftGame, setDraftGame] = useState<PanelBroadcastGame[]>([]);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const canEdit = canManage(role);
  const gameSearch = useCallback((query: string) => searchChannelGames(channelId, query), [channelId]);
  const gameLookup = useCallback((ids: readonly string[]) => lookupChannelGames(channelId, ids), [channelId]);

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const openEditor = (): void => {
    const current = broadcast.data;
    setDraftTitle(current?.title ?? "");
    setDraftGame(current?.game === null || current?.game === undefined ? [] : [current.game]);
    setSaveError(undefined);
    setOpened(true);
  };

  const reconnect = (): void => {
    window.location.assign(`/auth/channels/${encodeURIComponent(channelId)}/broadcaster-scopes/broadcast`);
  };

  const save = async (): Promise<void> => {
    if (pending || !canEdit || !broadcast.data?.manageScopeAvailable || draftTitle.trim().length === 0) return;
    setPending(true);
    setSaveError(undefined);
    try {
      await saveChannelBroadcast(channelId, draftTitle.trim(), draftGame[0]?.id ?? "");
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, {
        title: draftTitle.trim(),
        game: draftGame[0] ?? null,
        manageScopeAvailable: true,
      });
      setOpened(false);
      if (activeRef.current) onSaved(labels.broadcastSaved);
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (error: unknown) {
      if (!activeRef.current) return;
      if (error instanceof PanelApiError && error.code === "broadcast_scope_missing") {
        queryClient.setQueryData(key, (current: typeof broadcast.data) => ({
          ...current,
          manageScopeAvailable: false,
        }));
        setSaveError(labels.broadcastScopeMissing);
      } else if (error instanceof PanelApiError && error.code === "broadcast_identity_missing") {
        setSaveError(labels.broadcastIdentityMissing);
      } else {
        setSaveError(labels.broadcastSaveError);
      }
    } finally {
      if (activeRef.current) setPending(false);
    }
  };

  const data = broadcast.data;
  const scopeMissing = data?.manageScopeAvailable === false;
  const reconnectAction = scopeMissing
    ? role === "broadcaster"
      ? <Button size="compact" variant="secondary" onClick={reconnect}>{labels.broadcastReconnect}</Button>
      : <span className="live-cockpit-broadcast__reason" role="note">{labels.broadcastReconnectOwnerOnly}</span>
    : null;

  return <div className="live-cockpit-header__title-slot" data-slot="stream-title-category" aria-busy={broadcast.isPending}>
    {broadcast.isPending ? <p className="live-cockpit-broadcast__status" role="status">{labels.broadcastLoading}</p>
      : broadcast.isError || data === undefined ? <div className="live-cockpit-broadcast__status" role="alert">
        <span>{labels.broadcastUnavailable}</span>
        <Button size="compact" variant="subtle" disabled={broadcast.isFetching} onClick={() => { void broadcast.refetch(); }}>{common.retry}</Button>
      </div> : <>
        <div className="live-cockpit-broadcast__copy">
          <strong title={data.title || labels.broadcastEmptyTitle}>{data.title || labels.broadcastEmptyTitle}</strong>
          <span>{data.game?.name ?? labels.broadcastNoCategory}</span>
        </div>
        <div className="live-cockpit-broadcast__actions">
          <Button size="compact" variant="subtle" disabled={!canEdit || scopeMissing}
            {...(!canEdit ? { title: labels.broadcastManagerOnly } : scopeMissing ? { title: labels.broadcastScopeMissing } : {})}
            onClick={openEditor}>{labels.broadcastEdit}</Button>
          {!canEdit ? <span className="live-cockpit-broadcast__reason" role="note">{labels.broadcastManagerOnly}</span> : null}
          {reconnectAction}
          {scopeMissing ? <span className="live-cockpit-broadcast__reason" role="note">{labels.broadcastScopeMissing}</span> : null}
        </div>
      </>}

    <FormDialog
      opened={opened}
      title={labels.broadcastEdit}
      confirmLabel={labels.broadcastSave}
      cancelLabel={common.cancel}
      onConfirm={() => { void save(); }}
      onCancel={() => { if (!pending) setOpened(false); }}
      pending={pending}
      confirmDisabled={!canEdit || !data?.manageScopeAvailable || draftTitle.trim().length === 0 || draftTitle.length > 140}
      {...(saveError === undefined ? {} : { error: saveError })}
    >
      <div className="live-cockpit-broadcast__form">
        <Field
          id="live-cockpit-broadcast-title"
          label={labels.broadcastTitleLabel}
          value={draftTitle}
          maxLength={140}
          countLabel={labels.broadcastTitleCount}
          required
          disabled={pending || !canEdit}
          onChange={setDraftTitle}
        />
        <GameMultiSelect
          searchGames={gameSearch}
          lookupGames={gameLookup}
          value={draftGame}
          onChange={(games) => { setDraftGame(games.slice(0, 1)); }}
          messages={labels.broadcastGamePicker}
          maximum={1}
          disabled={pending || !canEdit}
        />
        {scopeMissing ? <div className="live-cockpit-broadcast__scope-warning">
          <span>{labels.broadcastScopeMissing}</span>{reconnectAction}
        </div> : null}
      </div>
    </FormDialog>
  </div>;
};
