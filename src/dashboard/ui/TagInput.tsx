import { TagsInput as MantineTagsInput, Pill } from "@mantine/core";
import { useId, useRef, useState, type ReactNode } from "react";

import { Icon } from "./Icon";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";

export interface TagInputMessages {
  countLabel: (count: number, maxTags: number) => ReactNode;
  atLimitHint: string;
  duplicateWarning: (entry: string) => string;
}

interface TagInputBaseProps {
  label: string;
  hint: string;
  error?: string;
  warning?: string;
  invalidValues?: readonly string[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  prefix?: string;
  normalize?: (entry: string) => string;
  validate?: (entry: string) => string | null;
  removeLabel: (entry: string) => string;
  disabled?: boolean;
  messages: TagInputMessages;
  listLabel: string;
}

export type TagInputProps = TagInputBaseProps & (
  | { maxTags: number }
  | { maxTags?: undefined }
);

const normalizeEntry = (entry: string, prefix: string | undefined, normalize: ((entry: string) => string) | undefined): string => {
  let next = normalize?.(entry) ?? entry;
  if (prefix !== undefined && next.startsWith(prefix)) next = next.slice(prefix.length);
  return next;
};

export function TagInput({ label, hint, error, warning, invalidValues = [], value, onChange, prefix, normalize, validate, maxTags, removeLabel, disabled = false, messages, listLabel }: TagInputProps) {
  const id = useId();
  const disabledReason = useDisabledFieldReason();
  const [searchValue, setSearchValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const skipNextClear = useRef(false);
  const preserveDuplicateWarning = useRef(false);
  const atLimit = maxTags !== undefined && value.length >= maxTags;
  const effectiveHint = atLimit ? messages.atLimitHint : hint;
  const effectiveError = error ?? validationError;
  const effectiveWarning = warning ?? duplicateWarning;
  const describedBy = [`${id}-description`, effectiveError === null ? null : `${id}-error`, effectiveWarning === null ? null : `${id}-warning`]
    .filter((part): part is string => part !== null)
    .join(" ");
  const prefixed = (entry: string): string => `${prefix ?? ""}${entry}`;

  const handleTagsChange = (nextTags: string[]): void => {
    const currentValues = new Set(value);
    const accepted: string[] = [];
    const rejected: string[] = [];
    let nextError: string | null = null;
    let nextWarning: string | null = null;
    for (const raw of nextTags) {
      const normalized = normalizeEntry(raw, prefix, normalize);
      if (normalized.length === 0) continue;
      if (accepted.includes(normalized)) {
        preserveDuplicateWarning.current = true;
        nextWarning ??= messages.duplicateWarning(prefixed(normalized));
        continue;
      }
      if (currentValues.has(normalized)) {
        accepted.push(normalized);
        continue;
      }
      const invalid = validate?.(normalized) ?? null;
      if (invalid !== null) {
        rejected.push(raw);
        nextError ??= invalid;
        continue;
      }
      accepted.push(normalized);
    }
    setValidationError(nextError);
    setDuplicateWarning(nextWarning);
    if (rejected.length > 0) {
      setSearchValue(rejected.join(", "));
      skipNextClear.current = true;
    }
    onChange(maxTags === undefined ? accepted : accepted.slice(0, maxTags));
  };

  const handleDuplicate = (entry: string): void => {
    const normalized = normalizeEntry(entry, prefix, normalize);
    preserveDuplicateWarning.current = true;
    setDuplicateWarning(messages.duplicateWarning(prefixed(normalized)));
    setValidationError(null);
  };

  return (
    <div className="ui-tag-input" role="group" aria-label={listLabel}>
      <MantineTagsInput
        id={id}
        label={label}
        description={<span className="ui-tag-input__description"><span>{effectiveHint}</span>{maxTags === undefined ? null : <span className="ui-tag-input__count">{messages.countLabel(value.length, maxTags)}</span>}{describedHelper(null, disabledReason, `tag-${id}`)}</span>}
        error={effectiveError === null ? undefined : `× ${effectiveError}`}
        inputWrapperOrder={["label", "input", "description", "error"]}
        data={[]}
        value={[...value]}
        onChange={handleTagsChange}
        searchValue={searchValue}
        onSearchChange={(next) => {
          if (next.length === 0 && skipNextClear.current) {
            skipNextClear.current = false;
            return;
          }
          setSearchValue(next);
          setValidationError(null);
          if (next.length === 0 && preserveDuplicateWarning.current) {
            preserveDuplicateWarning.current = false;
            return;
          }
          setDuplicateWarning(null);
        }}
        onDuplicate={handleDuplicate}
        splitChars={[",", " "]}
        allowDuplicates={false}
        {...(maxTags === undefined ? {} : { maxTags })}
        disabled={disabled || atLimit}
        aria-disabled={atLimit || disabled}
        aria-describedby={describedBy}
        className="ui-tag-input__control"
        leftSection={prefix === undefined ? undefined : <span className="ui-field__prefix" aria-hidden="true">{prefix}</span>}
        leftSectionWidth={prefix === undefined ? undefined : 36}
        leftSectionPointerEvents="none"
        {...(prefix === undefined ? {} : { styles: { section: { borderRight: "1px solid var(--line)" } } })}
        renderPill={({ value: tag, onRemove }) => tag === undefined ? null : (
          <Pill className="ui-tag-input__pill" size="sm" withRemoveButton={false} key={tag} aria-invalid={invalidValues.includes(tag)} data-invalid={invalidValues.includes(tag) || undefined}>
            <span className="ui-tag-input__pill-label">{prefixed(tag)}</span>
            <button className="ui-tag-input__remove" type="button" aria-label={removeLabel(prefixed(tag))} disabled={disabled} onClick={onRemove}>
              <Icon name="close" size={16} />
            </button>
          </Pill>
        )}
      />
      {effectiveWarning === null ? null : <span className="ui-tag-input__warning" id={`${id}-warning`}>{effectiveWarning}</span>}
    </div>
  );
}
