import type { ReactElement } from "react";
import { Textarea, type SettingsCustomFieldProps, type SettingsEditorDefinition, type SettingsEditorSpec } from "../../../dashboard/ui";
import type { DuelSettings, DuelTexts } from "../contracts";
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
    const textInput = (id: string, label: string, value: string, rows: number, onChange: (next: string) => void): ReactElement => (
      <label className="duel-settings-editor__text-field" key={id}>
        <span>{label}</span>
        <Textarea rows={rows} maxLength={500} value={value} disabled={props.disabled || props.readOnly}
          onChange={(event) => onChange(event.currentTarget.value)} />
      </label>
    );
    const updateText = (key: "challengeOpen" | "challengeTargeted" | "result" | "botResult", value: string): void => {
      props.onChange({ ...texts, [key]: value });
    };
    const variantInputs = (bot: boolean): ReactElement[] => {
      const key = bot ? "botFightVariants" : "fightVariants";
      return texts[key].map((value, index) => textInput(
        `${key}-${String(index)}`,
        bot ? copy.botFight.replace("{{index}}", String(index + 1)) : copy.fight.replace("{{index}}", String(index + 1)),
        value,
        2,
        (next) => {
          const variants = [...texts[key]];
          variants[index] = next;
          props.onChange({ ...texts, [key]: variants });
        },
      ));
    };
    const errorLabels: Readonly<Record<keyof DuelTexts["errors"], string>> = {
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
    const errorInputs = (Object.keys(errorLabels) as Array<keyof DuelTexts["errors"]>).map((key) => textInput(
      `error-${key}`,
      errorLabels[key],
      texts.errors[key],
      2,
      (value) => props.onChange({ ...texts, errors: { ...texts.errors, [key]: value } }),
    ));
    return <div className="duel-settings-editor__text-groups">
      <div className="duel-settings-editor__text-group">
        {textInput("challenge-open", copy.textChallengeOpen, texts.challengeOpen, 3, (value) => updateText("challengeOpen", value))}
        {textInput("challenge-targeted", copy.textChallengeTargeted, texts.challengeTargeted, 3, (value) => updateText("challengeTargeted", value))}
        {textInput("result", copy.textResult, texts.result, 3, (value) => updateText("result", value))}
        {textInput("bot-result", copy.textBotResult, texts.botResult, 3, (value) => updateText("botResult", value))}
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
      { kind: "text", key: "challengeCommand", prefix: "!", maxLength: 25 },
      { kind: "text", key: "acceptCommand", prefix: "!", maxLength: 25 },
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
};

export default definition;
