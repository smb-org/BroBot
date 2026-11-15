import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { runModuleQueryWrite, useDashboardQueryClient } from "../../../dashboard/data";
import { dashboardTexts } from "../../../dashboard/locale";
import {
  Button,
  ChipsInput,
  ConfirmDialog,
  Field,
  FieldPair,
  RoleThreshold,
  SaveStatus,
  Section,
  SegmentChoice,
  SwitchRow,
  UnitInput,
  registerDashboardNavigationGuard,
  useDraft,
  useDraftGuard,
} from "../../../dashboard/ui";
import type { SongRequestsSettings } from "../contracts";
import { saveSettings } from "./service";
import type { SongRequestsSettingsRead } from "./service";
import { songRequestsSettingsTexts } from "./settings-locale";

export default function SongRequestsSettingsEditor({
  channelId,
  language,
  settings,
  pointsEnabled,
  canManage,
}: {
  channelId: string;
  language: "de" | "en";
  settings: SongRequestsSettingsRead;
  pointsEnabled: boolean;
  canManage: boolean;
}): ReactElement {
  const labels = songRequestsSettingsTexts[language];
  const queryClient = useDashboardQueryClient();
  const draft = useDraft(settings.settings);
  const baselineRevision = useRef(settings.revision);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const saveInFlight = useRef<Promise<string | null> | null>(null);
  const disabled = !canManage || pending;

  useEffect(() => {
    if (draft.dirty || baselineRevision.current === settings.revision) return;
    baselineRevision.current = settings.revision;
    draft.accept(settings.settings);
    setSaved(false);
  }, [draft.accept, draft.dirty, settings.revision, settings.settings]);

  const update = useCallback((patch: Partial<SongRequestsSettings>): void => {
    draft.setValue((current) => ({ ...current, ...patch }));
    setSaved(false);
    setSaveError(undefined);
  }, [draft.setValue]);
  const updateRule = useCallback(<K extends keyof SongRequestsSettings["rules"],>(key: K, value: SongRequestsSettings["rules"][K]): void => {
    draft.setValue((current) => ({ ...current, rules: { ...current.rules, [key]: value } }));
    setSaved(false);
    setSaveError(undefined);
  }, [draft.setValue]);
  const updateNumber = (value: number | "", updateValue: (value: number) => void, fallback: number): void => {
    updateValue(typeof value === "number" && Number.isFinite(value) ? value : fallback);
  };

  const saveDraft = useCallback((): Promise<string | null> => {
    if (!canManage || !draft.dirty) return Promise.resolve(null);
    if (saveInFlight.current !== null) return saveInFlight.current;
    setPending(true);
    setSaved(false);
    setSaveError(undefined);
    const operation = (async (): Promise<string | null> => {
      try {
        const result = await runModuleQueryWrite(
          queryClient,
          channelId,
          "song_requests",
          "settings",
          (revision) => saveSettings(channelId, revision ?? baselineRevision.current, draft.value),
          { baselineRevision: baselineRevision.current, updateCache: (_current, savedSettings) => savedSettings },
        );
        baselineRevision.current = result.revision;
        draft.accept(result.settings);
        setSaved(true);
        return null;
      } catch (error: unknown) {
        const message = error instanceof Error && error.message.includes("conflict") ? labels.conflict : labels.saveError;
        setSaveError(message);
        return message;
      } finally {
        saveInFlight.current = null;
        setPending(false);
      }
    })();
    saveInFlight.current = operation;
    return operation;
  }, [canManage, channelId, draft.accept, draft.dirty, draft.value, labels.conflict, labels.saveError, queryClient]);

  const guard = useDraftGuard(draft.dirty, saveDraft, draft.reset);
  useEffect(() => registerDashboardNavigationGuard(guard.guardSwitch), [guard.guardSwitch]);
  const navigation = dashboardTexts(language).module;
  const rule = draft.value.rules;

  return <div className="song-requests-settings-editor">
    <Section title={labels.mode}>
      <SegmentChoice
        label={labels.mode}
        value={draft.value.mode}
        disabled={disabled}
        onChange={(mode) => { update({ mode }); }}
        options={[
          { value: "automatic", label: labels.automatic },
          { value: "moderated", label: labels.moderated },
        ]}
        wrap
      />
      {pointsEnabled || draft.value.paymentMode === "free" ? <SegmentChoice
        label={labels.payment}
        value={draft.value.paymentMode}
        disabled={disabled}
        onChange={(paymentMode) => { update({ paymentMode }); }}
        options={pointsEnabled ? [
          { value: "bot_points", label: labels.botPoints },
          { value: "free", label: labels.free },
        ] : [{ value: "free", label: labels.free }]}
        wrap
      /> : <div className="song-requests-settings-editor__disabled-note" role="status">
        <p>{labels.pointsUnavailable}</p>
        <Button variant="secondary" disabled={disabled} onClick={() => { update({ paymentMode: "free" }); }}>{labels.switchToFree}</Button>
      </div>}
      {draft.value.paymentMode === "bot_points" && pointsEnabled ? <UnitInput
        label={labels.cost}
        min={1}
        max={1_000_000}
        value={draft.value.botPointsCost}
        disabled={disabled}
        onChange={(value) => { updateNumber(value, (botPointsCost) => { update({ botPointsCost }); }, draft.value.botPointsCost); }}
      /> : null}
      {draft.value.paymentMode === "free" ? <RoleThreshold
        label={labels.freeRole}
        value={draft.value.freeRoleThreshold}
        options={labels.roles.map((role) => ({ ...role }))}
        disabled={disabled}
        onChange={(freeRoleThreshold) => { update({ freeRoleThreshold: freeRoleThreshold as SongRequestsSettings["freeRoleThreshold"] }); }}
      /> : null}
      <SwitchRow
        label={labels.alsoOffline}
        description={labels.alsoOfflineDescription}
        checked={draft.value.alsoOffline}
        disabled={disabled}
        onChange={(alsoOffline) => { update({ alsoOffline }); }}
      />
      <FieldPair>
        <UnitInput label={labels.overlayRows} min={2} max={20} value={draft.value.queueOverlayRows} disabled={disabled}
          onChange={(value) => { updateNumber(value, (queueOverlayRows) => { update({ queueOverlayRows }); }, draft.value.queueOverlayRows); }} />
        <Field label={labels.emptyText} value={draft.value.emptyText} onChange={(emptyText) => { update({ emptyText: emptyText.slice(0, 80) }); }} disabled={disabled} />
      </FieldPair>
    </Section>

    <Section title={labels.rules}>
      <SwitchRow label={labels.duplicate} checked={rule.duplicateEnabled} disabled={disabled} onChange={(value) => { updateRule("duplicateEnabled", value); }} />
      <SwitchRow label={labels.songCooldown} checked={rule.songCooldownEnabled} disabled={disabled} onChange={(value) => { updateRule("songCooldownEnabled", value); }} />
      {rule.songCooldownEnabled ? <>
        <SegmentChoice label={labels.songCooldown} value={rule.songCooldownOncePerRound ? "round" : "minutes"}
          disabled={disabled} onChange={(value) => { updateRule("songCooldownOncePerRound", value === "round"); }}
          options={[{ value: "minutes", label: labels.cooldownMinutes }, { value: "round", label: labels.oncePerRound }]} wrap />
        {!rule.songCooldownOncePerRound ? <UnitInput label={labels.songCooldownMinutes} unit="min" min={1} max={10_080}
          value={rule.songCooldownMinutes} disabled={disabled}
          onChange={(value) => { updateNumber(value, (next) => { updateRule("songCooldownMinutes", next); }, rule.songCooldownMinutes); }} /> : null}
      </> : null}
      <SwitchRow label={labels.personCooldown} checked={rule.personCooldownEnabled} disabled={disabled} onChange={(value) => { updateRule("personCooldownEnabled", value); }} />
      {rule.personCooldownEnabled ? <UnitInput label={labels.personCooldown} unit="min" min={0} max={10_080} value={rule.personCooldownMinutes} disabled={disabled}
        onChange={(value) => { updateNumber(value, (next) => { updateRule("personCooldownMinutes", next); }, rule.personCooldownMinutes); }} /> : null}
      <FieldPair>
        <div className="song-requests-settings-editor__rule-field"><SwitchRow label={labels.personOpen} checked={rule.personOpenLimitEnabled} disabled={disabled} onChange={(value) => { updateRule("personOpenLimitEnabled", value); }} />
          <UnitInput label={labels.personOpen} min={1} max={50} value={rule.personOpenLimit} disabled={disabled || !rule.personOpenLimitEnabled}
            onChange={(value) => { updateNumber(value, (next) => { updateRule("personOpenLimit", next); }, rule.personOpenLimit); }} /></div>
        <div className="song-requests-settings-editor__rule-field"><SwitchRow label={labels.personRound} checked={rule.personRoundLimitEnabled} disabled={disabled} onChange={(value) => { updateRule("personRoundLimitEnabled", value); }} />
          <UnitInput label={labels.personRound} min={1} max={100} value={rule.personRoundLimit} disabled={disabled || !rule.personRoundLimitEnabled}
            onChange={(value) => { updateNumber(value, (next) => { updateRule("personRoundLimit", next); }, rule.personRoundLimit); }} /></div>
      </FieldPair>
      <FieldPair>
        <div className="song-requests-settings-editor__rule-field"><SwitchRow label={labels.channelOpen} checked={rule.channelOpenLimitEnabled} disabled={disabled} onChange={(value) => { updateRule("channelOpenLimitEnabled", value); }} />
          <UnitInput label={labels.channelOpen} min={1} max={200} value={rule.channelOpenLimit} disabled={disabled || !rule.channelOpenLimitEnabled}
            onChange={(value) => { updateNumber(value, (next) => { updateRule("channelOpenLimit", next); }, rule.channelOpenLimit); }} /></div>
        <div className="song-requests-settings-editor__rule-field"><SwitchRow label={labels.artistOpen} checked={rule.artistOpenLimitEnabled} disabled={disabled} onChange={(value) => { updateRule("artistOpenLimitEnabled", value); }} />
          <UnitInput label={labels.artistOpen} min={1} max={50} value={rule.artistOpenLimit} disabled={disabled || !rule.artistOpenLimitEnabled}
            onChange={(value) => { updateNumber(value, (next) => { updateRule("artistOpenLimit", next); }, rule.artistOpenLimit); }} /></div>
      </FieldPair>
      <SwitchRow label={labels.maxLength} checked={rule.maxTrackLengthEnabled} disabled={disabled} onChange={(value) => { updateRule("maxTrackLengthEnabled", value); }} />
      {rule.maxTrackLengthEnabled ? <UnitInput label={labels.maxLengthMinutes} unit="min" min={1} max={1_000} value={rule.maxTrackLengthMinutes} disabled={disabled}
        onChange={(value) => { updateNumber(value, (next) => { updateRule("maxTrackLengthMinutes", next); }, rule.maxTrackLengthMinutes); }} /> : null}
      <SwitchRow label={labels.blockTracks} checked={rule.blockTracksEnabled} disabled={disabled} onChange={(value) => { updateRule("blockTracksEnabled", value); }} />
      {rule.blockTracksEnabled ? <ChipsInput label={labels.blockedTrackIds} values={rule.blockedTrackIds} onChange={(values) => { updateRule("blockedTrackIds", values); }}
        max={200} disabled={disabled} placeholder={labels.listPlaceholder} removeLabel={labels.removeItem} listLabel={labels.blockedTrackIds}
        messages={{ countLabel: labels.chipCount, atLimitHint: labels.chipLimit, duplicateWarning: labels.duplicateChip }} /> : null}
      <SwitchRow label={labels.blockArtists} checked={rule.blockArtistsEnabled} disabled={disabled} onChange={(value) => { updateRule("blockArtistsEnabled", value); }} />
      {rule.blockArtistsEnabled ? <ChipsInput label={labels.blockedArtists} values={rule.blockedArtists} onChange={(values) => { updateRule("blockedArtists", values); }}
        max={100} disabled={disabled} placeholder={labels.listPlaceholder} removeLabel={labels.removeItem} listLabel={labels.blockedArtists}
        messages={{ countLabel: labels.chipCount, atLimitHint: labels.chipLimit, duplicateWarning: labels.duplicateChip }} /> : null}
      <SwitchRow label={labels.explicitAllowed} checked={rule.explicitAllowed} disabled={disabled} onChange={(value) => { updateRule("explicitAllowed", value); }} />
    </Section>

    {canManage ? <SaveStatus dirty={draft.dirty} persistent pending={pending} saved={saved} {...(saveError === undefined ? {} : { error: saveError })}
      onSave={() => { void saveDraft(); }} onDiscard={() => { draft.reset(); setSaved(false); setSaveError(undefined); }}
      saveLabel={labels.save} discardLabel={labels.discard} savedLabel={labels.saved} pendingLabel={labels.saving} /> : null}
    <ConfirmDialog opened={guard.confirmOpen} title={navigation.unsavedChangesTitle} description={navigation.unsavedChangesDescription}
      confirmLabel={navigation.discardAndSwitch} cancelLabel={navigation.continueEditing} onConfirm={guard.discardAndSwitch} onCancel={guard.continueEditing}
      {...(canManage ? { alternative: { label: navigation.saveAndSwitch, onClick: () => { void guard.saveAndSwitch(); } } } : {})}
      pending={guard.saving || pending} {...(guard.saveError === undefined ? {} : { error: guard.saveError })} />
  </div>;
}
