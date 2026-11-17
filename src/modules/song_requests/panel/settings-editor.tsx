import type { ReactElement } from "react";

import { ChipsInput, FieldPair, SegmentChoice, SwitchRow, UnitInput, type SettingsCustomFieldProps, type SettingsEditorDefinition, type SettingsEditorSpec } from "../../../dashboard/ui";
import type { SongRequestsSettings } from "../contracts";
import { renderTemplate } from "../../contract";
import { SONG_REQUEST_TEMPLATE_VARIABLES } from "../contracts/template-variables";
import { songRequestSettingsEditorCatalog } from "./settings-editor-locale";
import { songRequestsSettingsTexts } from "./settings-locale";
import "./settings-editor.css";

const songRequestTemplatePreview = (template: string, values: Readonly<Record<string, string>>): string => {
  const samples = Object.fromEntries(SONG_REQUEST_TEMPLATE_VARIABLES.map(({ name, sample }) => [name, sample]));
  return renderTemplate(template, { user: "Maple Viewer", ...samples, ...values }, {}, SONG_REQUEST_TEMPLATE_VARIABLES);
};

const languageFrom = (context: unknown): "de" | "en" => typeof context === "object" && context !== null &&
  "language" in context && context.language === "en" ? "en" : "de";

const updateNumber = (value: number | "", update: (next: number) => void): void => {
  if (typeof value === "number" && Number.isFinite(value)) update(value);
};

const skipVoteField = {
  kind: "custom" as const,
  key: "skipVote" as const,
  render: (props: SettingsCustomFieldProps<SongRequestsSettings>): ReactElement => {
    const copy = songRequestsSettingsTexts[languageFrom(props.context)];
    const value = props.settings.skipVote;
    const disabled = props.disabled || props.readOnly;
    return <>
      <SwitchRow label={copy.skipVoteEnabled} checked={value.enabled} disabled={disabled}
        onChange={(enabled) => { props.onChange({ ...value, enabled }); }} />
      <FieldPair>
        <UnitInput label={copy.skipThreshold} min={1} max={100} value={value.threshold} disabled={disabled || !value.enabled}
          onChange={(next) => { updateNumber(next, (threshold) => { props.onChange({ ...value, threshold }); }); }} />
        <UnitInput label={copy.skipCooldown} unit="s" min={0} max={3600} value={value.cooldownSeconds} disabled={disabled || !value.enabled}
          onChange={(next) => { updateNumber(next, (cooldownSeconds) => { props.onChange({ ...value, cooldownSeconds }); }); }} />
      </FieldPair>
    </>;
  },
};

const paymentModeField = {
  kind: "custom" as const,
  key: "paymentMode" as const,
  render: (props: SettingsCustomFieldProps<SongRequestsSettings>): ReactElement => {
    const copy = songRequestsSettingsTexts[languageFrom(props.context)];
    const enabledModuleIds = typeof props.context === "object" && props.context !== null &&
      "enabledModuleIds" in props.context && Array.isArray(props.context.enabledModuleIds)
      ? props.context.enabledModuleIds
      : [];
    const pointsEnabled = enabledModuleIds.includes("points");
    return <SegmentChoice
      label={props.label}
      hint={props.hint}
      value={props.settings.paymentMode}
      disabled={props.disabled || props.readOnly}
      onChange={(value) => { props.onChange(value); }}
      {...(pointsEnabled ? {} : { warning: copy.pointsUnavailable })}
      options={[
        { value: "bot_points", label: copy.botPoints, ...(pointsEnabled ? {} : { disabled: true }) },
        { value: "free", label: copy.free },
      ]}
    />;
  },
};

const requestAlertField = {
  kind: "custom" as const,
  key: "requestAlert" as const,
  render: (props: SettingsCustomFieldProps<SongRequestsSettings>): ReactElement => {
    const copy = songRequestsSettingsTexts[languageFrom(props.context)];
    return <SwitchRow label={copy.requestAlertEnabled} checked={props.settings.requestAlert.enabled}
      disabled={props.disabled || props.readOnly}
      onChange={(enabled) => { props.onChange({ enabled }); }} />;
  },
};

const rulesField = {
  kind: "custom" as const,
  key: "rules" as const,
  render: (props: SettingsCustomFieldProps<SongRequestsSettings>): ReactElement => {
    const labels = songRequestsSettingsTexts[languageFrom(props.context)];
    const rules = props.settings.rules;
    const disabled = props.disabled || props.readOnly;
    const update = <Key extends keyof SongRequestsSettings["rules"]>(key: Key, value: SongRequestsSettings["rules"][Key]): void => {
      props.onChange({ ...rules, [key]: value });
    };
    const limitRule = (
      label: string,
      enabledKey: "personCooldownEnabled" | "personOpenLimitEnabled" | "personRoundLimitEnabled" | "channelOpenLimitEnabled" | "artistOpenLimitEnabled" | "maxTrackLengthEnabled",
      valueKey: "personCooldownMinutes" | "personOpenLimit" | "personRoundLimit" | "channelOpenLimit" | "artistOpenLimit" | "maxTrackLengthMinutes",
      minimum: number,
      maximum: number,
      unit?: string,
    ): ReactElement => <SwitchRow label={label} checked={rules[enabledKey]} disabled={disabled}
      onChange={(enabled) => { update(enabledKey, enabled); }}
      control={<UnitInput label={label} ariaLabel={label} hideLabel {...(unit === undefined ? {} : { unit })} min={minimum} max={maximum} value={rules[valueKey]}
        disabled={disabled || !rules[enabledKey]}
        onChange={(next) => { updateNumber(next, (value) => { update(valueKey, value); }); }} />} />;
    return <div className="song-request-rules">
      <SwitchRow label={labels.duplicate} checked={rules.duplicateEnabled} disabled={disabled}
        onChange={(enabled) => { update("duplicateEnabled", enabled); }} />
      <SwitchRow label={labels.songCooldown} checked={rules.songCooldownEnabled} disabled={disabled}
        onChange={(enabled) => { update("songCooldownEnabled", enabled); }}
        control={<UnitInput label={labels.songCooldown} ariaLabel={labels.songCooldown} hideLabel unit="min" min={1} max={10_080} value={rules.songCooldownMinutes}
          disabled={disabled || !rules.songCooldownEnabled || rules.songCooldownOncePerRound}
          onChange={(next) => { updateNumber(next, (minutes) => { update("songCooldownMinutes", minutes); }); }} />} />
      <SwitchRow label={labels.oncePerRound} description={labels.oncePerRoundHint} checked={rules.songCooldownOncePerRound}
        disabled={disabled || !rules.songCooldownEnabled} onChange={(enabled) => { update("songCooldownOncePerRound", enabled); }} />
      {limitRule(labels.personCooldown, "personCooldownEnabled", "personCooldownMinutes", 0, 10_080, "min")}
      {limitRule(labels.personOpen, "personOpenLimitEnabled", "personOpenLimit", 1, 50)}
      {limitRule(labels.personRound, "personRoundLimitEnabled", "personRoundLimit", 1, 100)}
      {limitRule(labels.channelOpen, "channelOpenLimitEnabled", "channelOpenLimit", 1, 200)}
      {limitRule(labels.artistOpen, "artistOpenLimitEnabled", "artistOpenLimit", 1, 50)}
      {limitRule(labels.maxLength, "maxTrackLengthEnabled", "maxTrackLengthMinutes", 1, 1_000, "min")}
      <SwitchRow label={labels.explicitAllowed} checked={rules.explicitAllowed} disabled={disabled}
        onChange={(enabled) => { update("explicitAllowed", enabled); }} />
      <SwitchRow label={labels.blockTracks} checked={rules.blockTracksEnabled} disabled={disabled}
        onChange={(enabled) => { update("blockTracksEnabled", enabled); }} />
      <ChipsInput label={labels.blockedTrackIds} values={rules.blockedTrackIds} onChange={(values) => { update("blockedTrackIds", values); }}
        max={200} disabled={disabled || !rules.blockTracksEnabled} placeholder={labels.listPlaceholder} removeLabel={labels.removeItem} listLabel={labels.blockedTrackIds}
        messages={{ countLabel: labels.chipCount, atLimitHint: labels.chipLimit, duplicateWarning: labels.duplicateChip }} />
      <SwitchRow label={labels.blockArtists} checked={rules.blockArtistsEnabled} disabled={disabled}
        onChange={(enabled) => { update("blockArtistsEnabled", enabled); }} />
      <ChipsInput label={labels.blockedArtists} values={rules.blockedArtists} onChange={(values) => { update("blockedArtists", values); }}
        max={100} disabled={disabled || !rules.blockArtistsEnabled} placeholder={labels.listPlaceholder} removeLabel={labels.removeItem} listLabel={labels.blockedArtists}
        messages={{ countLabel: labels.chipCount, atLimitHint: labels.chipLimit, duplicateWarning: labels.duplicateChip }} />
    </div>;
  },
};

const spec: SettingsEditorSpec<SongRequestsSettings> = {
  sections: [
    { id: "admission", icon: "tabSettings", fields: [
      { kind: "segment", key: "mode", options: [{ value: "automatic" }, { value: "moderated" }] },
      paymentModeField,
      { kind: "number", key: "botPointsCost", min: 1, max: 1_000_000, step: 1 },
      { kind: "roleThreshold", key: "freeRoleThreshold", options: [{ value: "everyone" }, { value: "subscriber" }, { value: "vip" }, { value: "moderator" }] },
      { kind: "switchCard", key: "alsoOffline" },
    ] },
    { id: "rules", icon: "clock-hour-4", fields: [rulesField] },
    { id: "skipVote", icon: "vote", fields: [skipVoteField] },
    { id: "alert", icon: "music", fields: [requestAlertField] },
    { id: "overlay", icon: "tabSettings", fields: [
      { kind: "number", key: "queueOverlayRows", min: 2, max: 20, step: 1 },
      { kind: "text", key: "emptyText", maxLength: 80, optional: true },
    ] },
    { id: "messages", icon: "tabMessages", fields: [
      { kind: "message", key: "queuedText", enabledKey: "queuedTextEnabled", preview: songRequestTemplatePreview },
      { kind: "message", key: "waitingText", enabledKey: "waitingTextEnabled", preview: songRequestTemplatePreview },
      { kind: "message", key: "requestAlertText", enabledKey: "requestAlertTextEnabled", preview: songRequestTemplatePreview },
    ] },
  ],
};

const definition: SettingsEditorDefinition<SongRequestsSettings> = {
  spec,
  locales: songRequestSettingsEditorCatalog.locales,
  layout: "columns",
  pageColumns: [["admission", "rules"], ["skipVote", "alert", "overlay", "messages"]],
  savePosition: "page-header",
  showTitle: false,
  messageFields: [
    { messagePath: "queuedText", enabledPath: "queuedTextEnabled" },
    { messagePath: "waitingText", enabledPath: "waitingTextEnabled" },
    { messagePath: "requestAlertText", enabledPath: "requestAlertTextEnabled" },
  ],
};

export default definition;
