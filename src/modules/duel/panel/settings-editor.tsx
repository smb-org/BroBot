import type { ReactElement } from "react";
import { SwitchRow, Textarea, type SettingsCustomFieldProps, type SettingsEditorDefinition, type SettingsEditorSpec } from "../../../dashboard/ui";
import { isMessageEnabled } from "../../../contracts/message-enabled";
import type { DuelErrorMessageKey, DuelSettings } from "../contracts";
import { duelPanelCopy } from "../locale";
import { duelSettingsEditorCatalog } from "./settings-editor-locale";
import "./settings-editor.css";

const languageFrom = (context: unknown): "de" | "en" => {
  if (typeof context !== "object" || context === null || !("language" in context)) return "de";
  return context.language === "en" ? "en" : "de";
};

const textLibraryField = {
  kind: "custom" as const,
  key: "texts" as const,
  render: (props: SettingsCustomFieldProps<DuelSettings>): ReactElement => {
    const language = languageFrom(props.context);
    const copy = duelPanelCopy[language];
    const texts = props.settings.texts;
    const messageInput = (
      id: string,
      label: string,
      value: string,
      enabled: boolean,
      errorKey: string,
      rows: number,
      onTextChange: (next: string) => void,
      onEnabledChange: (next: boolean) => void,
    ): ReactElement => {
      const error = props.fieldErrors?.[errorKey];
      // The id follows the settings-<path> convention the editor shell uses to focus an invalid field.
      const inputId = `settings-${errorKey.replaceAll(".", "-")}`;
      const errorId = `${inputId}-error`;
      return <div className="duel-settings-editor__text-field" key={id}>
        <div className="duel-settings-editor__text-heading">
          <label htmlFor={inputId}>{label}</label>
          {props.readOnly
            ? <strong>{enabled ? copy.messageOn : copy.messageOff}</strong>
            : <SwitchRow
              label={copy.messageEnabled}
              ariaLabel={`${label}: ${copy.messageEnabled}`}
              checked={enabled}
              disabled={props.disabled}
              onChange={onEnabledChange}
            />}
        </div>
        <Textarea id={inputId} rows={rows} maxLength={500} value={value} disabled={props.disabled || props.readOnly}
          aria-invalid={error === undefined ? undefined : true} aria-describedby={error === undefined ? undefined : errorId}
          onChange={(event) => onTextChange(event.currentTarget.value)} />
        <span id={errorId} className="duel-settings-editor__text-error" role={error === undefined ? undefined : "alert"}>{error ?? "\u00a0"}</span>
      </div>;
    };
    const updateText = (key: "challengeOpen" | "challengeTargeted" | "result" | "botResult", value: string): void => {
      props.onChange({ ...texts, [key]: value });
    };
    const updateEnabled = (key: "challengeOpen" | "challengeTargeted" | "result" | "botResult", value: boolean): void => {
      props.onChange({ ...texts, [`${key}Enabled`]: value });
    };
    const variantInputs = (bot: boolean): ReactElement[] => {
      const key = bot ? "botFightVariants" : "fightVariants";
      const enabledKey = bot ? "botFightVariantsEnabled" : "fightVariantsEnabled";
      return texts[key].map((value, index) => messageInput(
        `${key}-${String(index)}`,
        bot ? copy.botFight.replace("{{index}}", String(index + 1)) : copy.fight.replace("{{index}}", String(index + 1)),
        value,
        isMessageEnabled(texts, key, enabledKey, index),
        `texts.${key}.${String(index)}`,
        2,
        (next) => {
          const variants = [...texts[key]];
          variants[index] = next;
          props.onChange({ ...texts, [key]: variants });
        },
        (next) => {
          const existing = texts[enabledKey] ?? texts[key].map((_text, itemIndex) => isMessageEnabled(texts, key, enabledKey, itemIndex));
          const enabled = [...existing];
          enabled[index] = next;
          props.onChange({ ...texts, [enabledKey]: enabled });
        },
      ));
    };
    const errorLabels: Readonly<Record<DuelErrorMessageKey, string>> = {
      notEnoughPoints: copy.errorNotEnoughPoints,
      invalidStake: copy.errorInvalidStake,
      unknownUser: copy.errorUnknownUser,
      targetBusy: copy.errorTargetBusy,
      alreadyChallenging: copy.errorAlreadyChallenging,
      cooldown: copy.errorCooldown,
      noOpenChallenge: copy.errorNoOpenChallenge,
      cannotAcceptOwn: copy.errorCannotAcceptOwn,
      stakeBounds: copy.errorStakeBounds,
      tooManyOpen: copy.errorTooManyOpen,
    };
    const errorInputs = (Object.keys(errorLabels) as DuelErrorMessageKey[]).map((key) => messageInput(
      `error-${key}`,
      errorLabels[key],
      texts.errors[key],
      isMessageEnabled(texts.errors, key, `${key}Enabled`),
      `texts.errors.${key}`,
      2,
      (value) => props.onChange({ ...texts, errors: { ...texts.errors, [key]: value } }),
      (value) => props.onChange({ ...texts, errors: { ...texts.errors, [`${key}Enabled`]: value } }),
    ));
    return <div className="duel-settings-editor__text-groups">
      <div className="duel-settings-editor__text-group">
        {messageInput("challenge-open", copy.textChallengeOpen, texts.challengeOpen, isMessageEnabled(texts, "challengeOpen", "challengeOpenEnabled"), "texts.challengeOpen", 3,
          (value) => updateText("challengeOpen", value), (value) => updateEnabled("challengeOpen", value))}
        {messageInput("challenge-targeted", copy.textChallengeTargeted, texts.challengeTargeted, isMessageEnabled(texts, "challengeTargeted", "challengeTargetedEnabled"), "texts.challengeTargeted", 3,
          (value) => updateText("challengeTargeted", value), (value) => updateEnabled("challengeTargeted", value))}
        {messageInput("result", copy.textResult, texts.result, isMessageEnabled(texts, "result", "resultEnabled"), "texts.result", 3,
          (value) => updateText("result", value), (value) => updateEnabled("result", value))}
        {messageInput("bot-result", copy.textBotResult, texts.botResult, isMessageEnabled(texts, "botResult", "botResultEnabled"), "texts.botResult", 3,
          (value) => updateText("botResult", value), (value) => updateEnabled("botResult", value))}
      </div>
      <div className="duel-settings-editor__text-group">
        {variantInputs(false)}
        {variantInputs(true)}
      </div>
      <div className="duel-settings-editor__text-group">
        {errorInputs}
      </div>
    </div>;
  },
};

const spec: SettingsEditorSpec<DuelSettings> = {
  sections: [
    { id: "commands", icon: "tabMessages", fields: [
      { kind: "text", key: "challengeCommand", maxLength: 25 },
      { kind: "text", key: "acceptCommand", maxLength: 25 },
    ] },
    { id: "stakes", icon: "tabSettings", fields: [
      { kind: "number", key: "minStake", min: 1, max: 100_000, step: 1 },
      { kind: "number", key: "defaultStake", min: 1, max: 100_000, step: 1 },
      { kind: "number", key: "maxStake", min: 1, max: 100_000, step: 1 },
    ] },
    { id: "rules", icon: "clock-hour-4", fields: [
      { kind: "number", key: "acceptWindowSeconds", min: 15, max: 300, step: 1, unit: "s" },
      { kind: "number", key: "cooldownSeconds", min: 0, max: 3_600, step: 1, unit: "s" },
      { kind: "switchCard", key: "botAcceptsOpenDuels" },
      { kind: "switchCard", key: "broadcasterModsMayPlay" },
    ] },
    { id: "chat", icon: "tabMessages", fields: [
      { kind: "chatTarget", key: "chatTarget", allowed: ["all_chats", "source_only", "where_asked"] },
    ] },
    { id: "texts", icon: "tabMessages", fields: [
      textLibraryField,
    ] },
  ],
};

const definition: SettingsEditorDefinition<DuelSettings> = {
  spec,
  locales: duelSettingsEditorCatalog,
  layout: "columns",
  pageColumns: [["commands", "rules", "chat"], ["stakes"], ["texts"]],
  savePosition: "page-header",
  showTitle: false,
  className: "duel-settings-editor",
  messageFields: [
    { messagePath: "texts.challengeOpen", enabledPath: "texts.challengeOpenEnabled" },
    { messagePath: "texts.challengeTargeted", enabledPath: "texts.challengeTargetedEnabled" },
    { messagePath: "texts.result", enabledPath: "texts.resultEnabled" },
    { messagePath: "texts.botResult", enabledPath: "texts.botResultEnabled" },
    { messagePath: "texts.fightVariants", enabledPath: "texts.fightVariantsEnabled" },
    { messagePath: "texts.botFightVariants", enabledPath: "texts.botFightVariantsEnabled" },
    ...(["notEnoughPoints", "invalidStake", "unknownUser", "targetBusy", "alreadyChallenging", "cooldown", "noOpenChallenge", "cannotAcceptOwn", "stakeBounds", "tooManyOpen"] as const)
      .map((key) => ({ messagePath: `texts.errors.${key}`, enabledPath: `texts.errors.${key}Enabled` })),
  ],
};

export default definition;
