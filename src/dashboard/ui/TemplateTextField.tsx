import { RichTextarea, type CaretPosition, type RichTextareaHandle } from "rich-textarea";
import { useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";

import { closestTemplateVariable, templateTextLength, tokenizeTemplate, unknownTemplateVariables, type TemplateToken, type TemplateVariable } from "../../template";
import type { TemplateVariableGroup } from "../../contracts/values";
import { Button } from "./Button";
import { FieldError } from "./FieldError";
import { Icon } from "./Icon";
import { InlineSuggestionPicker, InlineSuggestionPickerTarget } from "./InlineSuggestionPicker";
import { TruncatedText } from "./TruncatedText";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";
import { insertTextareaText } from "./textarea-insertion";
import {
  filterTemplateTextFieldOptions,
  groupTemplateTextFieldOptions,
  prioritizeTemplateTextFieldNamespace,
  reindexGroupedTemplateTextFieldOptions,
  type TemplateTextFieldGroupPresentation,
  type TemplateTextFieldOption,
  type TemplateTextFieldPickerMessages,
} from "./template-text-field-model";

export interface TemplateTextFieldVariable {
  name: string;
  label?: string;
  description: string;
  sample: string;
  pickerSample?: string;
  group?: TemplateVariableGroup;
  kind?: "system" | "module" | "channel";
  sourceGroup?: TemplateTextFieldGroupPresentation;
  isTextBlock?: boolean;
  external?: boolean;
  parameters?: NonNullable<TemplateVariable["parameters"]>;
  parameter?: { value: string };
}

export interface TemplateTextFieldMessages {
  countLabel: (count: number, maxLength: number) => string;
  previewCountLabel: (count: number) => ReactNode;
  openBrace: string;
  unknownVariable: (name: string, suggestion: string | null) => ReactNode;
  insertSuggestionLabel: (name: string) => string;
  insertionLimit: string;
  worstCaseLength: (length: number, maxLength: number) => ReactNode;
  picker: TemplateTextFieldPickerMessages;
}

interface TemplateTextFieldProps {
  label: string;
  hint: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  worstCaseLength?: number;
  variables?: readonly TemplateTextFieldVariable[];
  preview?: (template: string, values: Readonly<Record<string, string>>) => string;
  previewLabel?: string;
  previewSpeaker?: string;
  previewEmptyText?: string;
  insertVariableLabel?: string;
  onIssuesChange?: (issues: { unknown: readonly string[]; worstCaseExceeded: boolean }) => void;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  minRows?: number;
  id?: string;
  name?: string;
  messages: TemplateTextFieldMessages;
}

interface SuggestionQuery {
  fragment: string;
  start: number;
  end: number;
}

interface CaretAnchor {
  left: number;
  top: number;
}

interface TextRange {
  start: number;
  end: number;
}

const templateDeclarations = (options: readonly TemplateTextFieldVariable[]): TemplateVariable[] =>
  options.map((option) => ({
    name: option.name,
    sample: option.sample,
    maxLength: 0,
    group: option.group ?? "context",
    source: option.kind ?? "module",
    ...(option.parameters === undefined ? {} : { parameters: option.parameters }),
    ...(option.external === undefined ? {} : { external: option.external }),
  }));

const getSuggestionQuery = (value: string, caret: number): SuggestionQuery | null => {
  const prefix = value.slice(0, caret);
  const match = /\{([\p{L}\p{N}_.]*)$/u.exec(prefix);
  if (match === null) return null;
  const suffixMatch = /^[\p{L}\p{N}_.]*\}?/u.exec(value.slice(caret));
  return { fragment: match[1] ?? "", start: match.index + 1, end: caret + (suffixMatch?.[0].length ?? 0) };
};

const findOpenBrace = (value: string): number | null => {
  const opening = value.lastIndexOf("{");
  return opening > value.lastIndexOf("}") ? opening : null;
};

const suggestionQueryKey = (query: SuggestionQuery | null): string | null => query === null
  ? null
  : `${String(query.start)}:${String(query.end)}:${query.fragment}`;

const optionForPicker = (variable: TemplateTextFieldVariable): TemplateTextFieldOption => ({
  name: variable.name,
  label: variable.label ?? variable.name,
  description: variable.description,
  sample: variable.pickerSample ?? variable.sample,
  group: variable.group ?? "context",
  kind: variable.kind ?? "module",
  ...(variable.sourceGroup === undefined ? {} : { sourceGroup: variable.sourceGroup }),
  ...(variable.isTextBlock === undefined ? {} : { isTextBlock: variable.isTextBlock }),
  ...(variable.external === undefined ? {} : { external: variable.external }),
  ...(variable.parameter === undefined ? {} : { parameter: variable.parameter }),
});

const isLegacyCompositionKey = (event: object): boolean => Reflect.get(event, "keyCode") === 229;

export function TemplateTextField({
  label,
  hint,
  error,
  value,
  onChange,
  maxLength,
  worstCaseLength: suppliedWorstCaseLength,
  variables,
  preview,
  previewLabel,
  previewSpeaker,
  previewEmptyText,
  insertVariableLabel,
  onIssuesChange,
  disabled = false,
  readOnly = false,
  required = false,
  minRows = 4,
  id: suppliedId,
  name,
  messages,
}: TemplateTextFieldProps): ReactElement {
  const generatedId = useId();
  const disabledReason = useDisabledFieldReason();
  const id = suppliedId ?? `template-${generatedId}`;
  const listboxId = `${id}-suggestions`;
  const textareaRef = useRef<RichTextareaHandle>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const selectionAfterValue = useRef<{ value: string; range: TextRange; focus: boolean } | null>(null);
  const dismissedQuery = useRef<string | null>(null);
  const programmaticEdit = useRef(false);
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const [query, setQuery] = useState<SuggestionQuery | null>(null);
  const [insertionLimitReached, setInsertionLimitReached] = useState(false);
  const [caretAnchor, setCaretAnchor] = useState<CaretAnchor>({ left: 12, top: 32 });
  const declarations = useMemo(() => templateDeclarations(variables ?? []), [variables]);
  const count = variables === undefined ? value.length : templateTextLength(value);
  const overLimit = maxLength !== undefined && count > maxLength;
  const nearLimit = maxLength !== undefined && count >= maxLength * 0.9;
  const effectiveError = error ?? (overLimit ? messages.countLabel(count, maxLength) : undefined);
  const worstCase = suppliedWorstCaseLength;
  const worstCaseExceeded = maxLength !== undefined && worstCase !== undefined && worstCase > maxLength;
  const openBrace = variables !== undefined && findOpenBrace(value) !== null;
  const unknownVariables = useMemo(
    () => variables === undefined ? [] : unknownTemplateVariables(value, declarations),
    [declarations, value, variables],
  );
  const unknownPieces = useMemo(
    () => variables === undefined ? [] : tokenizeTemplate(value, declarations).filter((part) => part.kind === "unknown"),
    [declarations, value, variables],
  );
  const previewText = preview === undefined
    ? undefined
    : preview(value, Object.fromEntries((variables ?? []).map((variable) => [variable.name, variable.sample])));
  const suggestionGroups = useMemo(() => {
    if (query === null || variables === undefined) return [];
    const pickerMessages = messages.picker;
    const options = variables.map(optionForPicker);
    const filtered = filterTemplateTextFieldOptions(options, query.fragment);
    return reindexGroupedTemplateTextFieldOptions(prioritizeTemplateTextFieldNamespace(
      groupTemplateTextFieldOptions(filtered, pickerMessages, query.fragment),
      query.fragment,
    ));
  }, [messages.picker, query, variables]);
  const suggestionOpen = !disabled && !readOnly && !composing && variables !== undefined && query !== null;
  const unknownAdvice = useMemo(() => unknownVariables.map((tokenName) => ({
    tokenName,
    suggestion: closestTemplateVariable(tokenName, declarations),
  })), [declarations, unknownVariables]);

  const rememberSelection = (target: HTMLTextAreaElement): void => {
    selection.current = { start: target.selectionStart, end: target.selectionEnd };
  };

  const updateSuggestionQuery = (next: string, caret: number): void => {
    if (composingRef.current || disabled || readOnly || variables === undefined) {
      setQuery(null);
      return;
    }
    const nextQuery = getSuggestionQuery(next, caret);
    const nextKey = suggestionQueryKey(nextQuery);
    if (dismissedQuery.current !== null) {
      if (nextKey === dismissedQuery.current) {
        setQuery(null);
        return;
      }
      dismissedQuery.current = null;
    }
    setQuery(nextQuery);
  };

  const handleValueChange = (next: string, target: HTMLTextAreaElement): void => {
    setInsertionLimitReached(false);
    rememberSelection(target);
    const caret = target.selectionStart === 0 && target.selectionEnd === 0 && next.length > value.length
      ? next.length
      : target.selectionStart;
    selectionAfterValue.current = {
      value: next,
      range: target.selectionStart === 0 && target.selectionEnd === 0 && next.length > value.length
        ? { start: next.length, end: next.length }
        : { start: target.selectionStart, end: target.selectionEnd },
      focus: false,
    };
    onChange(next);
    updateSuggestionQuery(next, caret);
  };

  const handleSelectionChange = (position: CaretPosition): void => {
    selection.current = { start: position.selectionStart, end: position.selectionEnd };
    const textarea = textareaRef.current;
    const frame = frameRef.current;
    if (position.focused && textarea !== null && frame !== null) {
      const frameRect = frame.getBoundingClientRect();
      setCaretAnchor({
        left: position.left - frameRect.left,
        top: position.top - frameRect.top + position.height,
      });
      updateSuggestionQuery(textarea.value, position.selectionStart);
    } else if (!position.focused) {
      setQuery(null);
    }
  };

  const insertText = (insert: string, start: number, end: number, selectionAfter?: TextRange): void => {
    const textarea = textareaRef.current;
    if (textarea === null || disabled || readOnly) return;
    const nextValue = `${textarea.value.slice(0, start)}${insert}${textarea.value.slice(end)}`;
    const nextCount = variables === undefined ? nextValue.length : templateTextLength(nextValue);
    if (maxLength !== undefined && nextCount > maxLength) {
      setInsertionLimitReached(true);
      return;
    }
    programmaticEdit.current = true;
    insertTextareaText(textarea, insert, start, end);
    programmaticEdit.current = false;
    setInsertionLimitReached(false);
    const targetSelection = selectionAfter ?? { start: start + insert.length, end: start + insert.length };
    selection.current = targetSelection;
    selectionAfterValue.current = { value: nextValue, range: targetSelection, focus: true };
    onChange(nextValue);
    setQuery(null);
  };

  const openVariablePicker = (): void => {
    const textarea = textareaRef.current;
    if (textarea === null || variables === undefined || disabled || readOnly) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    insertText("{", start, end);
    const caret = start + 1;
    dismissedQuery.current = null;
    setQuery({ fragment: "", start: caret, end: caret });
  };

  const chooseSuggestion = (variableName: string): void => {
    const currentQuery = query;
    if (currentQuery === null) return;
    const parameter = variables?.find((variable) => variable.name === variableName)?.parameter;
    insertText(`{${variableName}${parameter === undefined ? "" : ` ${parameter.value}`}}`, currentQuery.start - 1, currentQuery.end);
  };

  const insertUnknownSuggestion = (token: TemplateToken, suggestion: string): void => {
    const name = token.name;
    if (name === undefined) return;
    insertText(suggestion, token.start + 1, token.start + 1 + name.length);
  };

  const onCompositionEnd = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    composingRef.current = false;
    setComposing(false);
    handleValueChange(event.currentTarget.value, event.currentTarget);
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    handlePickerKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean,
    closePicker: () => void,
  ): void => {
    const native = event.nativeEvent;
    const isComposing = composingRef.current || native.isComposing || isLegacyCompositionKey(native);
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      if (isComposing) return;
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (isComposing) return;
    if (handlePickerKeyDown(event)) return;
    if (suggestionOpen && (event.key === "}" || event.key === " ")) {
      closePicker();
    }
  };

  useEffect(() => {
    if (composing) return;
    onIssuesChange?.({ unknown: unknownVariables, worstCaseExceeded });
  }, [composing, onIssuesChange, unknownVariables, worstCaseExceeded]);

  useEffect(() => {
    const pendingSelection = selectionAfterValue.current;
    if (pendingSelection === null || pendingSelection.value !== value) return;
    selectionAfterValue.current = null;
    const textarea = textareaRef.current;
    if (textarea === null) return;
    if (pendingSelection.focus) textarea.focus();
    if (textarea.selectionStart !== pendingSelection.range.start || textarea.selectionEnd !== pendingSelection.range.end) {
      textarea.setSelectionRange(pendingSelection.range.start, pendingSelection.range.end);
    }
  }, [value]);

  const countNode = maxLength === undefined ? null : (
    <span className={`ui-template-text-field__count${nearLimit && !overLimit ? " ui-template-text-field__count--warning" : ""}${overLimit ? " ui-template-text-field__count--error" : ""}`} id={`${id}-count`}>
      {messages.countLabel(count, maxLength)}
    </span>
  );
  const previewIsEmpty = (previewText ?? "").trim().length === 0 && previewEmptyText !== undefined;
  const previewDisplayText = previewIsEmpty ? previewEmptyText : previewText ?? "";
  const previewNode = preview === undefined || previewLabel === undefined || previewSpeaker === undefined ? null : (
    <div className="ui-template-text-field__preview">
      <div className="ui-template-text-field__preview-header">
        <span className="ui-template-text-field__preview-label">{previewLabel}</span>
        {countNode}
      </div>
      <p className="ui-template-text-field__preview-message" title={previewIsEmpty ? previewDisplayText : `${previewSpeaker}: ${previewDisplayText}`}>
        {previewIsEmpty ? null : <>
          <span className="ui-template-text-field__preview-speaker">{previewSpeaker}</span>
          <span className="ui-template-text-field__preview-colon" aria-hidden="true">:</span>{" "}
        </>}
        <span className={`ui-template-text-field__preview-text${previewIsEmpty ? " ui-template-text-field__preview-text--empty" : ""}`} title={previewDisplayText}>{previewDisplayText}</span>
      </p>
    </div>
  );

  const description: ReactNode = (
    <div className="ui-template-text-field__description-content">
      {previewNode}
      <div className="ui-template-text-field__helper-row">
        <span className="ui-template-text-field__helper-copy">
          {effectiveError === undefined
            ? <TruncatedText text={hint} />
            : <FieldError id={`${id}-error`} className="ui-template-text-field__helper-error" message={effectiveError} />}
          {describedHelper(null, disabledReason, `template-text-field-${id}`)}
        </span>
        {previewNode === null ? countNode : null}
      </div>
      <div className="ui-template-text-field__warnings" id={`${id}-warnings`} aria-live="polite">
          {insertionLimitReached ? (
            <div className="ui-template-text-field__warning" role="status"><Icon name="warning" size={16} /><span>{messages.insertionLimit}</span></div>
          ) : null}
          {openBrace ? (
            <div className="ui-template-text-field__warning"><Icon name="warning" size={16} /><span>{messages.openBrace}</span></div>
          ) : null}
          {unknownAdvice.map(({ tokenName, suggestion }, index) => {
            const token = unknownPieces.find((piece) => piece.name === tokenName);
            return (
              <div className="ui-template-text-field__warning" key={`${tokenName}-${String(index)}`}>
                <Icon name="warning" size={16} />
                <span>{messages.unknownVariable(tokenName, suggestion)}</span>
                {suggestion === null || token === undefined ? null : (
                  <Button size="compact" variant="subtle" type="button" disabled={disabled || readOnly} onClick={() => insertUnknownSuggestion(token, suggestion)}>
                    {messages.insertSuggestionLabel(suggestion)}
                  </Button>
                )}
              </div>
            );
          })}
          {worstCaseExceeded ? (
            <div className="ui-template-text-field__warning"><Icon name="warning" size={16} /><span>{messages.worstCaseLength(worstCase, maxLength)}</span></div>
          ) : null}
      </div>
    </div>
  );

  const renderDecoratedValue = (text: string): ReactNode => variables === undefined
    ? text
    : tokenizeTemplate(text, declarations).map((part) => (
      part.kind === "text"
        ? part.text
        : <span key={`${String(part.start)}-${part.kind}`} data-kind={part.kind} className={`template-text-field__decoration template-text-field__decoration--${part.kind}`}>{part.text}</span>
    ));

  return (
    <InlineSuggestionPicker
      listboxId={listboxId}
      open={suggestionOpen}
      groups={suggestionGroups}
      messages={messages.picker}
      onSelect={chooseSuggestion}
      onClose={() => {
        dismissedQuery.current = suggestionQueryKey(query);
        setQuery(null);
      }}
      renderOption={(variable, active) => <>
        <span className="ui-template-text-field__suggestion-copy">
          <span className="ui-template-text-field__suggestion-name">{variable.label ?? variable.name}</span>
          <span className="ui-template-text-field__suggestion-token">{`{${variable.name}${variable.parameter === undefined ? "" : ` ${variable.parameter.value}`}}`}</span>
          {active ? <span className="ui-template-text-field__suggestion-description">{variable.description}</span> : null}
        </span>
        <span className={`ui-template-text-field__suggestion-sample${variable.isTextBlock ? " ui-template-text-field__suggestion-sample--tag" : ""}`}>
          {variable.sample}
        </span>
        {variable.external ? (
          <span className="ui-template-text-field__suggestion-external" role="img" title={messages.picker.externalHelp} aria-label={messages.picker.externalHelp}>
            <Icon name="cause" size={16} />
          </span>
        ) : null}
      </>}
    >
      {({ activeOptionId, handleKeyDown: handlePickerKeyDown, close }) => {
      const inputWrapper = (
      <div data-ui="" className="ui-template-text-field" id={`${id}-field`}>
        <div className="ui-template-text-field__label-row">
          <label className="ui-template-text-field__label" htmlFor={id}>
            {label}{required ? <span aria-hidden="true"> *</span> : null}
          </label>
          {insertVariableLabel === undefined ? null : <Button
            className="ui-template-text-field__insert-variable"
            size="compact"
            variant="subtle"
            type="button"
            disabled={disabled || readOnly || variables === undefined}
            onClick={openVariablePicker}
          >{insertVariableLabel}</Button>}
        </div>
        <div ref={frameRef} className="template-text-field" data-composing={composing ? "true" : undefined} data-readonly={readOnly ? "true" : undefined}>
          <RichTextarea
            data-ui=""
            className="template-text-field__input"
            ref={textareaRef}
            style={{ width: "100%" }}
            value={value}
            onChange={(event) => {
              if (programmaticEdit.current) {
                programmaticEdit.current = false;
                return;
              }
              handleValueChange(event.currentTarget.value, event.currentTarget);
            }}
            onSelectionChange={handleSelectionChange}
            onSelect={(event) => {
              rememberSelection(event.currentTarget);
              // Reads the DOM's live value, not the closed-over `value` prop:
              // the browser can fire `select` for the caret move a keystroke
              // causes before React has re-rendered with that keystroke's
              // value, and recomputing the query against the stale prop then
              // finds no match (wrong string/caret pairing) and closes a
              // suggestion dropdown that just opened.
              updateSuggestionQuery(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onClick={(event) => { rememberSelection(event.currentTarget); }}
            onKeyDown={(event) => { handleKeyDown(event, handlePickerKeyDown, close); }}
            onCompositionStart={() => { composingRef.current = true; setComposing(true); setQuery(null); }}
            onCompositionEnd={onCompositionEnd}
            onBlur={() => { setQuery(null); }}
            id={id}
            name={name}
            rows={minRows}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
            aria-invalid={effectiveError !== undefined || undefined}
            aria-describedby={`${id}-description${effectiveError === undefined ? "" : ` ${id}-error`}`}
            aria-autocomplete="list"
            aria-expanded={suggestionOpen}
            aria-controls={suggestionOpen ? listboxId : undefined}
            aria-activedescendant={suggestionOpen ? activeOptionId : undefined}
            spellCheck
          >
            {renderDecoratedValue}
          </RichTextarea>
            <InlineSuggestionPickerTarget>
            <span aria-hidden="true" className="template-text-field__caret-anchor" style={{ left: caretAnchor.left, top: caretAnchor.top }} />
            </InlineSuggestionPickerTarget>
        </div>
        <div className="ui-template-text-field__description" id={`${id}-description`}>{description}</div>
      </div>
      );
      return inputWrapper;
      }}
    </InlineSuggestionPicker>
  );
}
