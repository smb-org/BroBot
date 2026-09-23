import type { ReactElement } from "react";

import { worstCaseTemplateLength } from "../../template";
import type { IconName } from "./Icon";
import { ChoiceCards } from "./ChoiceCards";
import { Field } from "./Field";
import { NumberField } from "./NumberField";
import { SegmentedControl } from "./SegmentedControl";
import { Switch } from "./Switch";
import { TextArea, type TemplateVariableOption, type TextAreaMessages } from "./TextArea";

export type SettingsFieldSpec<Settings> =
  | { kind: "number"; key: keyof Settings & string; unit: string; min: number; max: number; step: number }
  | { kind: "text"; key: keyof Settings & string; prefix?: string; maxLength?: number }
  | { kind: "template"; key: keyof Settings & string; minRows?: number; preview: (template: string, samples: Readonly<Record<string, string>>) => string }
  | { kind: "segment"; key: keyof Settings & string; options: readonly { value: string }[] }
  | { kind: "choice"; key: keyof Settings & string; options: readonly { value: string; icon?: IconName }[] }
  | { kind: "switchCard"; key: keyof Settings & string; children?: readonly SettingsFieldSpec<Settings>[] };

export interface SettingsEditorSpec<Settings> {
  sections: readonly { id: string; icon: IconName; fields: readonly SettingsFieldSpec<Settings>[] }[];
}

export interface SettingsFieldText {
  label: string;
  hint: string;
  description?: string;
  disabledReason?: string;
  increaseLabel?: string;
  decreaseLabel?: string;
  options?: Readonly<Record<string, { label: string; description?: string }>>;
  countLabel?: (count: number, maxLength: number) => string;
  previewLabel?: string;
  previewSpeaker?: string;
}

export interface SettingsEditorTexts {
  sections: Readonly<Record<string, string>>;
  fields: Readonly<Record<string, SettingsFieldText>>;
}

export interface SettingsEditorProps<Settings extends object> {
  spec: SettingsEditorSpec<Settings>;
  sectionId: string;
  settings: Settings;
  onChange: <Key extends keyof Settings>(key: Key, value: Settings[Key]) => void;
  texts: SettingsEditorTexts;
  variables?: Readonly<Partial<Record<keyof Settings & string, readonly TemplateVariableOption[]>>>;
  templateMetadata?: Readonly<Partial<Record<keyof Settings & string, readonly (TemplateVariableOption & { maxLength: number; fallbackWhenAbsent?: number })[]>>>;
  templateMessages: TextAreaMessages;
  idPrefix?: string;
}

export function SettingsEditor<Settings extends object>({
  spec,
  sectionId,
  settings,
  onChange,
  texts,
  variables,
  templateMetadata,
  templateMessages,
  idPrefix = "settings",
}: SettingsEditorProps<Settings>): ReactElement {
  const section = spec.sections.find((candidate) => candidate.id === sectionId);

  const renderField = (field: SettingsFieldSpec<Settings>): ReactElement | null => {
    const copy = texts.fields[field.key];
    if (copy === undefined) return null;
    const id = `${idPrefix}-${field.key}`;
    const fieldValue = settings[field.key];
    if (field.kind === "number") {
      return (
        <NumberField
          key={field.key}
          id={id}
          label={copy.label}
          hint={copy.hint}
          unit={field.unit}
          min={field.min}
          max={field.max}
          step={field.step}
          increaseLabel={copy.increaseLabel ?? copy.label}
          decreaseLabel={copy.decreaseLabel ?? copy.label}
          value={typeof fieldValue === "number" ? fieldValue : fieldValue === "" ? "" : ""}
          onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
        />
      );
    }
    if (field.kind === "text") {
      const maxLength = field.maxLength;
      return (
        <Field
          key={field.key}
          id={id}
          label={copy.label}
          hint={copy.hint}
          value={typeof fieldValue === "string" ? fieldValue : ""}
          onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
          {...(field.prefix === undefined ? {} : { prefix: field.prefix })}
          {...(maxLength === undefined ? {} : { maxLength, countLabel: copy.countLabel ?? ((count, maximum) => `${String(count)} / ${String(maximum)}`) })}
        />
      );
    }
    if (field.kind === "template") {
      const metadata = templateMetadata?.[field.key];
      const fieldVariables = variables?.[field.key] ?? metadata?.map(({ name, description, sample }) => ({ name, description, sample }));
      return (
        <TextArea
          key={field.key}
          id={id}
          name={field.key}
          label={copy.label}
          hint={copy.hint}
          value={typeof fieldValue === "string" ? fieldValue : ""}
          onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
          maxLength={500}
          {...(metadata === undefined ? {} : { worstCaseLength: worstCaseTemplateLength(String(fieldValue ?? ""), metadata) })}
          {...(fieldVariables === undefined ? {} : { variables: fieldVariables })}
          preview={field.preview}
          {...(copy.previewLabel === undefined ? {} : { previewLabel: copy.previewLabel })}
          {...(copy.previewSpeaker === undefined ? {} : { previewSpeaker: copy.previewSpeaker })}
          {...(field.minRows === undefined ? {} : { minRows: field.minRows })}
          messages={templateMessages}
        />
      );
    }
    if (field.kind === "segment" || field.kind === "choice") {
      if (field.kind === "segment") {
        const options = field.options.map((option) => ({ value: option.value, label: copy.options?.[option.value]?.label ?? "" }));
        return (
          <SegmentedControl
            key={field.key}
            label={copy.label}
            hint={copy.options?.[String(fieldValue)]?.description ?? copy.hint}
            value={String(fieldValue ?? "")}
            onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
            options={options}
          />
        );
      }
      const options = field.options.map((option) => ({
        value: option.value,
        label: copy.options?.[option.value]?.label ?? "",
        description: copy.options?.[option.value]?.description ?? "",
        ...(option.icon === undefined ? {} : { icon: option.icon }),
      }));
      return (
        <ChoiceCards
          key={field.key}
          label={copy.label}
          hint={copy.hint}
          value={String(fieldValue ?? "")}
          onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
          options={options}
        />
      );
    }
    const children = field.children?.map(renderField) ?? [];
    return (
      <Switch
        key={field.key}
        layout="card"
        label={copy.label}
        hint={copy.hint}
        {...(copy.description === undefined ? {} : { description: copy.description })}
        checked={fieldValue === true}
        onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
        {...(copy.disabledReason === undefined ? {} : { lockedReason: copy.disabledReason })}
      >
        {field.children === undefined ? undefined : children as ReactElement[]}
      </Switch>
    );
  };

  return (
    <div className="ui-settings-editor" data-section={sectionId} aria-label={section === undefined ? undefined : texts.sections[section.id]}>
      {section?.fields.map(renderField)}
    </div>
  );
}
