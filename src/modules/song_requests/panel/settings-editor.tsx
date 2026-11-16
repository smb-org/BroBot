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

  type EnabledKey = "personCooldownEnabled" | "personOpenLimitEnabled" | "personRoundLimitEnabled" | "channelOpenLimitEnabled" | "artistOpenLimitEnabled" | "maxTrackLengthEnabled";
  type ValueKey = "personCooldownMinutes" | "personOpenLimit" | "personRoundLimit" | "channelOpenLimit" | "artistOpenLimit" | "maxTrackLengthMinutes";
  const limitRule = (label: string, enabledKey: EnabledKey, valueKey: ValueKey, min: number, max: number, unit?: string): ReactElement => {
    const enabled = rule[enabledKey];
    return <SwitchRow
      label={label}
      checked={enabled}
      disabled={disabled}
      onChange={(value) => { updateRule(enabledKey, value); }}
      control={<UnitInput label={label} {...(unit === undefined ? {} : { unit })} min={min} max={max} value={rule[valueKey]}
        disabled={disabled || !enabled}
        onChange={(value) => { updateNumber(value, (next) => { updateRule(valueKey, next); }, rule[valueKey]); }} />}
    />;
  };

  return <div className="song-requests-settings-editor">
    <Section title={labels.admission}>
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
    </Section>

    <Section title={labels.rules}>
      <SwitchRow label={labels.duplicate} checked={rule.duplicateEnabled} disabled={disabled} onChange={(value) => { updateRule("duplicateEnabled", value); }} />
      <SwitchRow
        label={labels.songCooldown}
        checked={rule.songCooldownEnabled}
        disabled={disabled}
        onChange={(value) => { updateRule("songCooldownEnabled", value); }}
        control={<UnitInput label={labels.songCooldown} unit="min" min={1} max={10_080} value={rule.songCooldownMinutes}
          disabled={disabled || !rule.songCooldownEnabled || rule.songCooldownOncePerRound}
          onChange={(value) => { updateNumber(value, (next) => { updateRule("songCooldownMinutes", next); }, rule.songCooldownMinutes); }} />}
      />
      <SwitchRow label={labels.oncePerRound} description={labels.oncePerRoundHint} checked={rule.songCooldownOncePerRound}
        disabled={disabled || !rule.songCooldownEnabled} onChange={(value) => { updateRule("songCooldownOncePerRound", value); }} />
      {limitRule(labels.personCooldown, "personCooldownEnabled", "personCooldownMinutes", 0, 10_080, "min")}
      {limitRule(labels.personOpen, "personOpenLimitEnabled", "personOpenLimit", 1, 50)}
      {limitRule(labels.personRound, "personRoundLimitEnabled", "personRoundLimit", 1, 100)}
      {limitRule(labels.channelOpen, "channelOpenLimitEnabled", "channelOpenLimit", 1, 200)}
      {limitRule(labels.artistOpen, "artistOpenLimitEnabled", "artistOpenLimit", 1, 50)}
      {limitRule(labels.maxLength, "maxTrackLengthEnabled", "maxTrackLengthMinutes", 1, 1_000, "min")}
      <SwitchRow label={labels.explicitAllowed} checked={rule.explicitAllowed} disabled={disabled} onChange={(value) => { updateRule("explicitAllowed", value); }} />
      <SwitchRow label={labels.blockTracks} checked={rule.blockTracksEnabled} disabled={disabled} onChange={(value) => { updateRule("blockTracksEnabled", value); }} />
      <ChipsInput label={labels.blockedTrackIds} values={rule.blockedTrackIds} onChange={(values) => { updateRule("blockedTrackIds", values); }}
        max={200} disabled={disabled || !rule.blockTracksEnabled} placeholder={labels.listPlaceholder} removeLabel={labels.removeItem} listLabel={labels.blockedTrackIds}
        messages={{ countLabel: labels.chipCount, atLimitHint: labels.chipLimit, duplicateWarning: labels.duplicateChip }} />
      <SwitchRow label={labels.blockArtists} checked={rule.blockArtistsEnabled} disabled={disabled} onChange={(value) => { updateRule("blockArtistsEnabled", value); }} />
      <ChipsInput label={labels.blockedArtists} values={rule.blockedArtists} onChange={(values) => { updateRule("blockedArtists", values); }}
        max={100} disabled={disabled || !rule.blockArtistsEnabled} placeholder={labels.listPlaceholder} removeLabel={labels.removeItem} listLabel={labels.blockedArtists}
        messages={{ countLabel: labels.chipCount, atLimitHint: labels.chipLimit, duplicateWarning: labels.duplicateChip }} />
    </Section>

    <Section title={labels.overlay}>
      <FieldPair>
        <UnitInput label={labels.overlayRows} min={2} max={20} value={draft.value.queueOverlayRows} disabled={disabled}
          onChange={(value) => { updateNumber(value, (queueOverlayRows) => { update({ queueOverlayRows }); }, draft.value.queueOverlayRows); }} />
        <Field label={labels.emptyText} value={draft.value.emptyText} onChange={(emptyText) => { update({ emptyText: emptyText.slice(0, 80) }); }} disabled={disabled} />
      </FieldPair>
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
