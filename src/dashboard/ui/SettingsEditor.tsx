import type { ReactElement } from "react";

import { worstCaseTemplateLength } from "../../template";
import type { PanelTemplateWarning } from "../../panel-contract";
import type { IconName } from "./Icon";
import type { ChatOutputTarget } from "../../contracts/values";
import { ChoiceCards } from "./ChoiceCards";
import { ChatTargetField } from "./ChatTargetField";
import { Field } from "./Field";
import { FieldError } from "./FieldError";
import { InspectorFieldRow, InspectorSection } from "./InspectorParts";
import { UnitInput } from "./UnitInput";
import { Select } from "./Select";
import { SegmentChoice } from "./SegmentChoice";
import { SwitchRow } from "./SwitchRow";
import { SwitchSection } from "./SwitchSection";
import { TemplateText } from "./TemplateText";
import { textFieldLength } from "./text-length";
import { TemplateTextField, type TemplateTextFieldVariable, type TemplateTextFieldMessages } from "./TemplateTextField";
import { TimeoutDurationRangeFields, type TimeoutDurationRangeValue } from "./TimeoutDurationRangeFields";

export type SettingsFieldSpec<Settings> =
  | { kind: "number"; key: keyof Settings & string; unit?: string; min: number; max: number; step: number; validate?: (value: number, settings: Settings) => boolean }
  | { kind: "timeoutDurationRange"; key: keyof Settings & string; min: number; max: number }
  | { kind: "text"; key: keyof Settings & string; prefix?: string; maxLength?: number; lengthUnit?: "utf16" | "codePoints"; optional?: boolean; validate?: (value: string) => boolean }
  | { kind: "template"; key: keyof Settings & string; minRows?: number; optional?: boolean; preview: (template: string, samples: Readonly<Record<string, string>>) => string }
  | { kind: "chatTarget"; key: keyof Settings & string; allowed?: readonly (ChatOutputTarget | "channel_default")[] }
  | { kind: "message"; key: keyof Settings & string; targetKey: keyof Settings & string; allowedTargets?: readonly (ChatOutputTarget | "channel_default")[]; preview: (template: string, samples: Readonly<Record<string, string>>) => string }
  | { kind: "select"; key: keyof Settings & string; options: readonly { value: string }[] }
  | { kind: "segment"; key: keyof Settings & string; options: readonly { value: string | number }[] }
  | { kind: "choice"; key: keyof Settings & string; options: readonly { value: string; icon?: IconName }[] }
  | { kind: "switchCard"; key: keyof Settings & string; children?: readonly SettingsFieldSpec<Settings>[] };

export interface SettingsEditorSpec<Settings> {
  sections: readonly { id: string; icon: IconName; fields: readonly SettingsFieldSpec<Settings>[] }[];
}

interface SettingsFieldText {
  label: string;
  hint: string;
  unit?: string;
  zeroValueLabel?: string;
  placeholder?: string;
  invalidError?: string;
  requiredError?: string;
  optionalHint?: string;
  description?: string;
  disabledReason?: string;
  minimumLabel?: string;
  maximumLabel?: string;
  options?: Readonly<Record<string, { label: string; description?: string }>>;
  countLabel?: (count: number, maxLength: number) => string;
  previewLabel?: string;
  previewSpeaker?: string;
  previewEmptyText?: string;
  variables?: readonly TemplateTextFieldVariable[];
}

interface SettingsEditorTexts {
  sections: Readonly<Record<string, string>>;
  fields: Readonly<Record<string, SettingsFieldText>>;
}

export interface SettingsEditorCatalog extends SettingsEditorTexts {
  title: string;
  ariaLabel: string;
  readOnlyReason: string;
  urlSaveError?: string;
  saveLabel: string;
  discardLabel: string;
  savedLabel: string;
  pendingLabel: string;
  invalidMessage: string;
  numberMissing: string;
  issueLabels: { error: string; warning: string };
  saveError: string;
  conflictMessage: string;
  reloadLabel: string;
  enabledLabel: string;
  disabledLabel: string;
  templateMessages: TemplateTextFieldMessages;
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
  variables?: Readonly<Partial<Record<keyof Settings & string, readonly TemplateTextFieldVariable[]>>>;
  templateMetadata?: Readonly<Partial<Record<keyof Settings & string, readonly (TemplateTextFieldVariable & { maxLength: number; fallbackWhenAbsent?: number })[]>>>;
  templateMessages: TemplateTextFieldMessages;
  messagePreviewLayout?: "stacked" | "side-by-side";
  readOnly?: boolean;
  readOnlySectionOnly?: boolean;
  disabled?: boolean;
  enabledLabel?: string;
  disabledLabel?: string;
  fieldErrors?: Readonly<Record<string, string>>;
  onIssuesChange?: (key: keyof Settings & string, issues: { unknown: readonly string[]; worstCaseExceeded: boolean }) => void;
  idPrefix?: string;
  effectiveDefaultChatTarget?: ChatOutputTarget;
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
  messagePreviewLayout = "stacked",
  readOnly = false,
  readOnlySectionOnly = false,
  disabled = false,
  enabledLabel,
  disabledLabel,
  fieldErrors = {},
  onIssuesChange,
  idPrefix = "settings",
  effectiveDefaultChatTarget,
}: SettingsEditorProps<Settings>): ReactElement {
  const section = spec.sections.find((candidate) => candidate.id === sectionId);

  const renderField = (field: SettingsFieldSpec<Settings>): ReactElement | null => {
    const copy = texts.fields[field.key];
    if (copy === undefined) return null;
    const id = `${idPrefix}-${field.key}`;
    const fieldValue = settings[field.key];
    if (readOnly) return renderReadOnlyField(field, copy, fieldValue, enabledLabel, disabledLabel);
    const error = fieldErrors[field.key];
    if (field.kind === "chatTarget") {
      return (
        <ChatTargetField
          key={field.key}
          label={copy.label}
          value={fieldValue === null || fieldValue === undefined || fieldValue === "channel_default" ? null : String(fieldValue) as ChatOutputTarget}
          onChange={(next) => { onChange(field.key, (next ?? (field.allowed?.includes("channel_default") ? "channel_default" : null)) as Settings[typeof field.key]); }}
          allowed={field.allowed ?? ["all_chats", "source_only"]}
          {...(effectiveDefaultChatTarget === undefined ? {} : { effectiveDefault: effectiveDefaultChatTarget })}
          disabled={disabled}
          reserveError
          {...(error === undefined ? {} : { error })}
        />
      );
    }
    if (field.kind === "select") {
      const options = field.options.map(({ value }) => ({ value, label: copy.options?.[value]?.label ?? "" }));
      return (
        <InspectorFieldRow key={field.key} label={copy.label} help={copy.hint}>
          <Select
            id={id}
            label={copy.label}
            hint={copy.hint}
            {...(error === undefined ? {} : { error })}
            value={typeof fieldValue === "string" ? fieldValue : null}
            onChange={(next) => { if (next !== null) onChange(field.key, next as Settings[typeof field.key]); }}
            options={options}
            required
            disabled={disabled}
          />
        </InspectorFieldRow>
      );
    }
    if (field.kind === "number") {
      const unit = typeof fieldValue === "number" && fieldValue === 0
        ? copy.zeroValueLabel ?? copy.unit ?? field.unit
        : copy.unit ?? field.unit;
      return <UnitInput
        key={field.key}
        id={id}
        label={copy.label}
        {...(unit === undefined ? {} : { unit })}
        hint={copy.hint}
        {...(error === undefined ? {} : { error })}
        min={field.min}
        max={field.max}
        step={field.step}
        value={typeof fieldValue === "number" ? fieldValue : ""}
        disabled={disabled}
        onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
      />;
    }
    if (field.kind === "timeoutDurationRange") {
      const range = fieldValue !== null && typeof fieldValue === "object"
        ? fieldValue as unknown as TimeoutDurationRangeValue
        : { minSeconds: "" as const, maxSeconds: "" as const };
      return (
        <InspectorFieldRow key={field.key} label={copy.label} help={copy.hint}>
          <TimeoutDurationRangeFields
            idPrefix={id}
            value={range}
            onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
            min={field.min}
            max={field.max}
            minimumLabel={copy.minimumLabel ?? copy.label}
            maximumLabel={copy.maximumLabel ?? copy.label}
            hint={copy.hint}
            disabled={disabled}
            {...(copy.unit === undefined ? {} : { unit: copy.unit })}
            {...(error === undefined ? {} : { error })}
          />
        </InspectorFieldRow>
      );
    }
    if (field.kind === "text") {
      const maxLength = field.maxLength;
      return (
        <InspectorFieldRow key={field.key} label={copy.label} help={copy.hint}>
          <Field
            id={id}
            label={copy.label}
            {...(error === undefined ? {} : { error })}
            value={typeof fieldValue === "string" ? fieldValue : ""}
            disabled={disabled}
            onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
            {...(copy.placeholder === undefined ? {} : { placeholder: copy.placeholder })}
            required={!field.optional}
            {...(field.prefix === undefined ? {} : { prefix: field.prefix })}
            {...(maxLength === undefined ? {} : { countLength: (text: string) => textFieldLength(field, text), maxLength, countLabel: copy.countLabel ?? ((count, maximum) => `${String(count)} / ${String(maximum)}`) })}
          />
        </InspectorFieldRow>
      );
    }
    if (field.kind === "template") {
      const metadata = templateMetadata?.[field.key];
      const fieldVariables = variables?.[field.key] ?? metadata?.map(({ name, description, sample }) => ({ name, description, sample }));
      return (
        <InspectorFieldRow key={field.key} label={copy.label} help={copy.hint}>
          <TemplateTextField
            id={id}
            name={field.key}
            label={copy.label}
            hint={field.optional ? copy.optionalHint ?? "" : ""}
            {...(error === undefined ? {} : { error })}
            value={typeof fieldValue === "string" ? fieldValue : ""}
            disabled={disabled}
            onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
            maxLength={500}
            {...(metadata === undefined ? {} : { worstCaseLength: worstCaseTemplateLength(String(fieldValue ?? ""), metadata) })}
            {...(fieldVariables === undefined ? {} : { variables: fieldVariables })}
            preview={field.preview}
            required={!field.optional}
            onIssuesChange={(issues) => { onIssuesChange?.(field.key, issues); }}
            {...(copy.previewLabel === undefined ? {} : { previewLabel: copy.previewLabel })}
            {...(copy.previewSpeaker === undefined ? {} : { previewSpeaker: copy.previewSpeaker })}
            {...(copy.previewEmptyText === undefined ? {} : { previewEmptyText: copy.previewEmptyText })}
            {...(field.minRows === undefined ? {} : { minRows: field.minRows })}
            messages={templateMessages}
          />
        </InspectorFieldRow>
      );
    }
    if (field.kind === "message") {
      const targetCopy = texts.fields[field.targetKey];
      const template = typeof fieldValue === "string" ? fieldValue : "";
      const targetValue = settings[field.targetKey];
      const targetError = fieldErrors[field.targetKey];
      const fieldVariables = variables?.[field.key] ?? templateMetadata?.[field.key]?.map(({ name, description, sample }) => ({ name, description, sample }));
      const metadata = templateMetadata?.[field.key];
      return <div key={field.key} className="ui-settings-editor__message" data-enabled={template.trim().length > 0}>
        <div className="ui-settings-editor__message-heading">
          <strong>{copy.label}</strong>
          <span>{template.trim().length > 0 ? enabledLabel : disabledLabel}</span>
        </div>
        <TemplateTextField
          id={id}
          name={field.key}
          label={copy.label}
          hint={copy.optionalHint ?? ""}
          {...(error === undefined ? {} : { error })}
          value={template}
          disabled={disabled}
          onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
          maxLength={500}
          {...(metadata === undefined ? {} : { worstCaseLength: worstCaseTemplateLength(template, metadata) })}
          {...(fieldVariables === undefined ? {} : { variables: fieldVariables })}
          preview={field.preview}
          previewLayout={messagePreviewLayout}
          required={false}
          onIssuesChange={(issues) => { onIssuesChange?.(field.key, issues); }}
          {...(copy.previewLabel === undefined ? {} : { previewLabel: copy.previewLabel })}
          {...(copy.previewSpeaker === undefined ? {} : { previewSpeaker: copy.previewSpeaker })}
          {...(copy.previewEmptyText === undefined ? {} : { previewEmptyText: copy.previewEmptyText })}
          minRows={2}
          messages={templateMessages}
        />
        {targetCopy === undefined ? null : <ChatTargetField
          label={targetCopy.label}
          value={targetValue === null || targetValue === undefined || targetValue === "channel_default" ? null : String(targetValue) as ChatOutputTarget}
          onChange={(next) => { onChange(field.targetKey, (next ?? (field.allowedTargets?.includes("channel_default") ? "channel_default" : null)) as Settings[typeof field.targetKey]); }}
          allowed={field.allowedTargets ?? ["all_chats", "source_only"]}
          {...(effectiveDefaultChatTarget === undefined ? {} : { effectiveDefault: effectiveDefaultChatTarget })}
          disabled={disabled}
          reserveError
          {...(targetError === undefined ? {} : { error: targetError })}
        />}
      </div>;
    }
    if (field.kind === "segment" || field.kind === "choice") {
      if (field.kind === "segment") {
        const options = field.options.map((option) => ({ value: String(option.value), label: copy.options?.[String(option.value)]?.label ?? "" }));
        return (
          <InspectorFieldRow key={field.key} label={copy.label} help={copy.options?.[String(fieldValue)]?.description ?? copy.hint}>
            <SegmentChoice
              label={copy.label}
              value={String(fieldValue ?? "")}
              onChange={(next) => {
                const selected = field.options.find((option) => String(option.value) === next)?.value ?? next;
                onChange(field.key, selected as Settings[typeof field.key]);
              }}
              options={options}
              disabled={disabled}
              reserveError
              {...(error === undefined ? {} : { error })}
            />
          </InspectorFieldRow>
        );
      }
      const options = field.options.map((option) => ({
        value: option.value,
        label: copy.options?.[option.value]?.label ?? "",
        description: copy.options?.[option.value]?.description ?? "",
        ...(option.icon === undefined ? {} : { icon: option.icon }),
      }));
      return (
        <InspectorFieldRow key={field.key} label={copy.label} help={copy.hint}>
          <ChoiceCards
            label={copy.label}
            value={String(fieldValue ?? "")}
            onChange={(next) => { onChange(field.key, next as Settings[typeof field.key]); }}
            options={options}
            disabled={disabled}
            reserveError
            {...(error === undefined ? {} : { error })}
          />
        </InspectorFieldRow>
      );
    }
    const children = field.children?.map(renderField) ?? [];
    const lockedReason = field.children === undefined ? copy.disabledReason : undefined;
    const checked = fieldValue === true;
    const onToggle = (next: boolean): void => { onChange(field.key, next as Settings[typeof field.key]); };
    const fieldError = <FieldError className="ui-field__error" message={error} />;
    if (field.children === undefined) return <div key={field.key}>
      <SwitchRow
        label={copy.label}
        description={copy.description ?? copy.hint}
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        {...(lockedReason === undefined ? {} : { lockedReason })}
      />
      {fieldError}
    </div>;
    return <div key={field.key}>
      <SwitchSection
        id={id}
        title={copy.label}
        hint={copy.description ?? copy.hint}
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        {...(lockedReason === undefined ? {} : { lockedReason })}
      >{children as ReactElement[]}</SwitchSection>
      {fieldError}
    </div>;
  };

  if (readOnly) {
    return (
      <InspectorSection title={section === undefined ? "" : texts.sections[section.id]}>
        <dl className="properties ui-settings-editor__properties">
          {flattenFields(readOnlySectionOnly ? section?.fields ?? [] : spec.sections.flatMap((candidate) => candidate.fields)).map((field) => {
            const copy = texts.fields[field.key];
            if (copy === undefined) return null;
            if (field.kind === "message") {
              const targetCopy = texts.fields[field.targetKey];
              const template = typeof settings[field.key] === "string" ? String(settings[field.key]) : "";
              const target = settings[field.targetKey];
              const targetLabel = targetCopy?.options?.[String(target)]?.label ?? String(target ?? "");
              return <div className="ui-settings-editor__readonly-message" key={field.key}>
                <dt>{copy.label}</dt>
                <dd>
                  <strong>{template.trim().length > 0 ? enabledLabel : disabledLabel}</strong>
                  <TemplateText value={template} variables={copy.variables ?? []} />
                  {targetCopy === undefined ? null : <span>{targetCopy.label}: {targetLabel}</span>}
                </dd>
              </div>;
            }
            return <div key={field.key}><dt>{copy.label}</dt><dd>{renderReadOnlyField(field, copy, settings[field.key], enabledLabel, disabledLabel)}</dd></div>;
          })}
        </dl>
      </InspectorSection>
    );
  }

  return (
    <div data-ui="" className="ui-settings-editor" data-section={sectionId} aria-label={section === undefined ? undefined : texts.sections[section.id]}>
      {section === undefined ? null : <InspectorSection title={texts.sections[section.id]}>
        {section.fields.map(renderField)}
      </InspectorSection>}
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
  if (field.kind === "message") return <>{String(value)}</>;
  if (field.kind === "switchCard") return <>{value === true ? enabledLabel : disabledLabel}</>;
  if (field.kind === "number") {
    if (typeof value === "number" && value === 0 && copy.zeroValueLabel !== undefined) return <>{copy.zeroValueLabel}</>;
    return <>{String(value)}{copy.unit === undefined ? "" : ` ${copy.unit}`}</>;
  }
  if (field.kind === "timeoutDurationRange") {
    const range = value !== null && typeof value === "object" ? value as unknown as TimeoutDurationRangeValue : null;
    if (range === null) return <></>;
    return range.minSeconds === range.maxSeconds
      ? <>{String(range.minSeconds)} {copy.unit ?? "s"}</>
      : <>{String(range.minSeconds)}–{String(range.maxSeconds)} {copy.unit ?? "s"}</>;
  }
  if (field.kind === "text") return <>{field.prefix ?? ""}{String(value)}</>;
  if (field.kind === "chatTarget") return <>{copy.options?.[String(value)]?.label ?? String(value)}</>;
  return <>{copy.options?.[String(value)]?.label ?? String(value)}</>;
};
