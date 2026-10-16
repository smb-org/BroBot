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

interface BroadcastEditorSnapshot {
  title: string;
  gameId: string;
}

export const LiveCockpitBroadcast = ({ channelId, role, onSaved, onQueryStateChange }: {
  channelId: string;
  role: ChannelRole;
  onSaved: (message: string) => void;
  onQueryStateChange: (state: "pending" | "ready" | "error") => void;
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
  const [openingSnapshot, setOpeningSnapshot] = useState<BroadcastEditorSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const canEdit = canManage(role);
  const gameSearch = useCallback((query: string) => searchChannelGames(channelId, query), [channelId]);
  const gameLookup = useCallback((ids: readonly string[]) => lookupChannelGames(channelId, ids), [channelId]);

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  useEffect(() => {
    onQueryStateChange(broadcast.isPending ? "pending" : broadcast.isError ? "error" : "ready");
  }, [broadcast.isError, broadcast.isPending, onQueryStateChange]);

  const openEditor = (): void => {
    const current = broadcast.data;
    const snapshot = {
      title: current?.title ?? "",
      gameId: current?.game?.id ?? "",
    };
    setOpeningSnapshot(snapshot);
    setDraftTitle(snapshot.title);
    setDraftGame(current?.game === null || current?.game === undefined ? [] : [current.game]);
    setSaveError(undefined);
    setOpened(true);
  };

  const reconnect = (): void => {
    window.location.assign(`/auth/channels/${encodeURIComponent(channelId)}/broadcaster-scopes/broadcast`);
  };

  const hasChanges = openingSnapshot !== null && (
    draftTitle.trim() !== openingSnapshot.title ||
    (draftGame[0]?.id ?? "") !== openingSnapshot.gameId
  );

  const save = async (): Promise<void> => {
    if (pending || !canEdit || !broadcast.data?.manageScopeAvailable || openingSnapshot === null ||
        draftTitle.trim().length === 0 || !hasChanges) return;
    const update: { title?: string; gameId?: string } = {};
    const title = draftTitle.trim();
    const gameId = draftGame[0]?.id ?? "";
    if (title !== openingSnapshot.title) update.title = title;
    if (gameId !== openingSnapshot.gameId) update.gameId = gameId;
    setPending(true);
    setSaveError(undefined);
    try {
      await saveChannelBroadcast(channelId, update);
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, (current: typeof broadcast.data) => {
        return {
          ...current,
          ...(update.title === undefined ? {} : { title: update.title }),
          ...(update.gameId === undefined ? {} : {
            game: update.gameId === "" ? null : draftGame[0] ?? null,
          }),
        };
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
  const lockedReasonId = "live-cockpit-broadcast-reason";
  const reconnectAction = scopeMissing
    ? <Button size="compact" variant="secondary" disabled={role !== "broadcaster"}
      {...(role !== "broadcaster" ? { title: labels.broadcastReconnectOwnerOnly } : {})}
      {...(role !== "broadcaster" ? { describedBy: lockedReasonId } : {})}
      onClick={reconnect}>{labels.broadcastReconnect}</Button>
    : null;
  const reason = data === undefined ? "" : !canEdit
    ? labels.broadcastManagerOnly
    : scopeMissing ? role === "broadcaster" ? labels.broadcastScopeMissing : labels.broadcastReconnectOwnerOnly : "";

  return <div className="live-cockpit-header__title-slot" data-slot="stream-title-category" aria-busy={broadcast.isPending}>
    <div className="live-cockpit-broadcast__copy">
      <div className="live-cockpit-broadcast__title-row">
        {broadcast.isPending ? <strong role="status">{labels.broadcastLoading}</strong>
          : broadcast.isError || data === undefined ? <strong role="alert">{labels.broadcastUnavailable}</strong>
            : <strong title={data.title || labels.broadcastEmptyTitle}>{data.title || labels.broadcastEmptyTitle}</strong>}
        {broadcast.isPending ? <span className="live-cockpit-broadcast__button-slot" aria-hidden="true" />
          : broadcast.isError || data === undefined ? <Button size="compact" variant="secondary" disabled={broadcast.isFetching}
            onClick={() => { void broadcast.refetch(); }}>{common.retry}</Button>
            : <Button size="compact" variant="secondary" icon="edit" iconOnly ariaLabel={labels.broadcastEdit}
              className="live-cockpit-broadcast__edit" disabled={!canEdit || scopeMissing}
              {...(!canEdit || scopeMissing ? { describedBy: lockedReasonId } : {})}
              onClick={openEditor} />}
      </div>
      <span>{data === undefined ? "" : data.game?.name ?? labels.broadcastNoCategory}</span>
    </div>
    <div className="live-cockpit-broadcast__actions">{reconnectAction}</div>
    <div className={`live-cockpit-broadcast__reason-slot${scopeMissing ? " is-warning" : ""}`} id={lockedReasonId}
      role={reason === "" ? undefined : "note"} title={reason}>
      {reason}
    </div>

    <FormDialog
      opened={opened}
      title={labels.broadcastEdit}
      confirmLabel={labels.broadcastSave}
      cancelLabel={common.cancel}
      onConfirm={() => { void save(); }}
      onCancel={() => { if (!pending) setOpened(false); }}
      pending={pending}
      confirmDisabled={!canEdit || !data?.manageScopeAvailable || !hasChanges || draftTitle.trim().length === 0 || draftTitle.length > 140}
      {...(saveError === undefined ? {} : { error: saveError })}
    >
      <div className="live-cockpit-broadcast__form">
        <Field
          id="live-cockpit-broadcast-title"
          label={labels.broadcastTitleLabel}
          value={draftTitle}
          maxLength={140}
          countLabel={labels.broadcastTitleCount}
          errorInDescription
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
          singleValue
          disabled={pending || !canEdit}
        />
        {scopeMissing ? <div className="live-cockpit-broadcast__scope-warning">
          <span>{labels.broadcastScopeMissing}</span>{reconnectAction}
        </div> : null}
      </div>
    </FormDialog>
  </div>;
};
