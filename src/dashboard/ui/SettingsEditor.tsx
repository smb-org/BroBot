import type { ReactElement } from "react";

import { worstCaseTemplateLength } from "../../template";
import type { PanelTemplateWarning } from "../../panel-contract";
import type { IconName } from "./Icon";
import { ChoiceCards } from "./ChoiceCards";
import { Field } from "./Field";
import { NumberField } from "./NumberField";
import { SegmentedControl } from "./SegmentedControl";
import { Switch } from "./Switch";
import { TemplateText } from "./TemplateText";
import { TextArea, type TemplateVariableOption, type TextAreaMessages } from "./TextArea";

export type SettingsFieldSpec<Settings> =
  | { kind: "number"; key: keyof Settings & string; unit?: string; min: number; max: number; step: number }
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
  unit?: string;
  requiredError?: string;
  description?: string;
  disabledReason?: string;
  increaseLabel?: string;
  decreaseLabel?: string;
  options?: Readonly<Record<string, { label: string; description?: string }>>;
  countLabel?: (count: number, maxLength: number) => string;
  previewLabel?: string;
  previewSpeaker?: string;
  variables?: readonly TemplateVariableOption[];
}

export interface SettingsEditorTexts {
  sections: Readonly<Record<string, string>>;
  fields: Readonly<Record<string, SettingsFieldText>>;
}

export interface SettingsEditorCatalog extends SettingsEditorTexts {
  title: string;
  ariaLabel: string;
  readOnlyReason: string;
  saveLabel: string;
  discardLabel: string;
  savedLabel: string;
  pendingLabel: string;
  invalidMessage: string;
  numberMissing: string;
  issueLabels: { error: string; warning: string };
  loadError: string;
  saveError: string;
  conflictMessage: string;
  reloadLabel: string;
  enabledLabel: string;
  disabledLabel: string;
  templateMessages: TextAreaMessages;
  warningLabel: (warning: PanelTemplateWarning) => string;
}

export interface SettingsEditorDefinition<Settings> {
  spec: SettingsEditorSpec<Settings>;
  locales: Readonly<Record<"de" | "en", SettingsEditorCatalog>>;
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
  readOnly?: boolean;
  disabled?: boolean;
  enabledLabel?: string;
  disabledLabel?: string;
  fieldErrors?: Readonly<Record<string, string>>;
  onIssuesChange?: (key: keyof Settings & string, issues: { unknown: readonly string[]; worstCaseExceeded: boolean }) => void;
  idPrefix?: string;
}

const flattenFields = <Settings,>(fields: readonly SettingsFieldSpec<Settings>[]): SettingsFieldSpec<Settings>[] =>
  fields.flatMap((field) => [field, ...(field.kind === "switchCard" && field.children !== undefined ? flattenFields(field.children) : [])]);

export function SettingsEditor<Settings extends object>({
  spec,
  sectionId,
  settings,
  onChange,
  texts,
  variables,
  templateMetadata,
  templateMessages,
  readOnly = false,
  disabled = false,
  enabledLabel,
  disabledLabel,
  fieldErrors = {},
  onIssuesChange,
  idPrefix = "settings",
}: SettingsEditorProps<Settings>): ReactElement {
  const section = spec.sections.find((candidate) => candidate.id === sectionId);

  const renderField = (field: SettingsFieldSpec<Settings>): ReactElement | null => {
    const copy = texts.fields[field.key];
    if (copy === undefined) return null;
    const id = `${idPrefix}-${field.key}`;
    const fieldValue = settings[field.key];
    if (readOnly) return renderReadOnlyField(field, copy, fieldValue, enabledLabel, disabledLabel);
    const error = fieldErrors[field.key];
    if (field.kind === "number") {
      return (
        <NumberField
          key={field.key}
          id={id}
          label={copy.label}
          hint={copy.hint}
          {...((copy.unit ?? field.unit) === undefined ? {} : { unit: copy.unit ?? field.unit })}
          {...(error === undefined ? {} : { error })}
          min={field.min}
          max={field.max}
          step={field.step}
          increaseLabel={copy.increaseLabel ?? copy.label}
          decreaseLabel={copy.decreaseLabel ?? copy.label}
          value={typeof fieldValue === "number" ? fieldValue : ""}
          disabled={disabled}
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
          {...(error === undefined ? {} : { error })}
          value={typeof fieldValue === "string" ? fieldValue : ""}
          disabled={disabled}
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
          {...(error === undefined ? {} : { error })}
          value={typeof fieldValue === "string" ? fieldValue : ""}
          disabled={disabled}
          onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
          maxLength={500}
          {...(metadata === undefined ? {} : { worstCaseLength: worstCaseTemplateLength(String(fieldValue ?? ""), metadata) })}
          {...(fieldVariables === undefined ? {} : { variables: fieldVariables })}
          preview={field.preview}
          required
          onIssuesChange={(issues) => { onIssuesChange?.(field.key, issues); }}
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
            disabled={disabled}
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
          disabled={disabled}
        />
      );
    }
    const children = field.children?.map(renderField) ?? [];
    const lockedReason = copy.disabledReason ?? field.children?.map((child) => texts.fields[child.key]?.disabledReason).find((reason) => reason !== undefined);
    return (
      <Switch
        key={field.key}
        layout="card"
        label={copy.label}
        description={copy.description ?? copy.hint}
        checked={fieldValue === true}
        onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
        {...(lockedReason === undefined ? {} : { lockedReason })}
      >
        {field.children === undefined ? undefined : children as ReactElement[]}
      </Switch>
    );
  };

  if (readOnly) {
    return (
      <dl className="properties ui-settings-editor__properties">
        {flattenFields(spec.sections.flatMap((candidate) => candidate.fields)).map((field) => {
          const copy = texts.fields[field.key];
          if (copy === undefined) return null;
          return <div key={field.key}><dt>{copy.label}</dt><dd>{renderReadOnlyField(field, copy, settings[field.key], enabledLabel, disabledLabel)}</dd></div>;
        })}
      </dl>
    );
  }

  return (
    <div className="ui-settings-editor" data-section={sectionId} aria-label={section === undefined ? undefined : texts.sections[section.id]}>
      {section?.fields.map(renderField)}
    </div>
  );
}

const renderReadOnlyField = <Settings extends object>(
  field: SettingsFieldSpec<Settings>,
  copy: SettingsFieldText,
  value: Settings[keyof Settings],
  enabledLabel: string | undefined,
  disabledLabel: string | undefined,
): ReactElement => {
  if (field.kind === "template") {
    const vars = copy.variables ?? [];
    return <TemplateText value={typeof value === "string" ? value : ""} variables={vars} />;
  }
  if (field.kind === "switchCard") return <>{value === true ? enabledLabel : disabledLabel}</>;
  if (field.kind === "number") return <>{String(value)}{copy.unit === undefined ? "" : ` ${copy.unit}`}</>;
  if (field.kind === "text") return <>{field.prefix ?? ""}{String(value)}</>;
  return <>{copy.options?.[String(value)]?.label ?? String(value)}</>;
};
