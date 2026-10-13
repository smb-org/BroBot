import { Combobox, Input, useCombobox } from "@mantine/core";
import { RichTextarea, type CaretPosition, type RichTextareaHandle } from "rich-textarea";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";

import { closestTemplateVariable, templateTextLength, tokenizeTemplate, unknownTemplateVariables, type TemplateVariable } from "../../template";
import type { TemplateVariableGroup } from "../../contracts/values";
import { Button } from "./Button";
import { ChatPreview } from "./ChatPreview";
import { Icon } from "./Icon";
import { TruncatedText } from "./TruncatedText";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";
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
  worstCaseLength: (length: number, maxLength: number) => ReactNode;
  picker?: TemplateTextFieldPickerMessages;
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

const fallbackPickerMessages: TemplateTextFieldPickerMessages = {
  title: "Choose a variable",
  noResults: "No variables found.",
  externalHelp: "Looks up live data from Twitch when the template runs",
  groupLabels: {
    module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks",
  },
  keyHints: { navigate: "select", insert: "insert", close: "close" },
};

const findOpenBrace = (value: string): number | null => {
  const opening = value.lastIndexOf("{");
  return opening > value.lastIndexOf("}") ? opening : null;
};

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

const GroupIcon = ({ group }: { group: TemplateTextFieldGroupPresentation }): ReactElement => group.iconPaths === undefined
  ? <Icon name={group.iconName ?? "variable"} size={16} />
  : (
    <svg className="ui-template-text-field__group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {group.iconPaths.map((path, index) => <path key={`${group.id}-${String(index)}`} d={path} />)}
    </svg>
  );

const TemplateTextFieldGroupHeading = ({ group }: { group: TemplateTextFieldGroupPresentation }): ReactElement => (
  <span className="ui-template-text-field__group-title"><GroupIcon group={group} /><span>{group.label}</span></span>
);

const TemplateTextFieldKeyboardHints = ({ messages }: { messages: TemplateTextFieldPickerMessages }): ReactElement => (
  <div className="ui-template-text-field__key-hints">
    <span><kbd>↑↓</kbd>{messages.keyHints.navigate}</span>
    <span><kbd>Enter</kbd>{messages.keyHints.insert}</span>
    <span><kbd>Esc</kbd>{messages.keyHints.close}</span>
  </div>
);

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
  const programmaticEdit = useRef(false);
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const [query, setQuery] = useState<SuggestionQuery | null>(null);
  const [caretAnchor, setCaretAnchor] = useState<CaretAnchor>({ left: 12, top: 32 });
  const [activeIndex, setActiveIndex] = useState(0);
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
  const deferredValue = useDeferredValue(value);
  const previewText = preview === undefined
    ? undefined
    : preview(deferredValue, Object.fromEntries((variables ?? []).map((variable) => [variable.name, variable.sample])));
  const previewCount = previewText?.length ?? 0;
  const suggestionGroups = useMemo(() => {
    if (query === null || variables === undefined) return [];
    const pickerMessages = messages.picker ?? fallbackPickerMessages;
    const options = variables.map(optionForPicker);
    const filtered = filterTemplateTextFieldOptions(options, query.fragment);
    return reindexGroupedTemplateTextFieldOptions(prioritizeTemplateTextFieldNamespace(
      groupTemplateTextFieldOptions(filtered, pickerMessages),
      query.fragment,
    ));
  }, [messages.picker, query, variables]);
  const suggestions = suggestionGroups.flatMap(({ options }) => options.map(({ option }) => option));
  const suggestionOpen = !disabled && !readOnly && !composing && variables !== undefined && query !== null;
  const activeSuggestion = suggestions[activeIndex] ?? suggestions[0];
  const unknownAdvice = useMemo(() => unknownVariables.map((tokenName) => ({
    tokenName,
    suggestion: closestTemplateVariable(tokenName, declarations),
  })), [declarations, unknownVariables]);
  const combobox = useCombobox({ onDropdownClose: () => { setActiveIndex(0); } });

  const rememberSelection = (target: HTMLTextAreaElement): void => {
    selection.current = { start: target.selectionStart, end: target.selectionEnd };
  };

  const updateSuggestionQuery = (next: string, caret: number): void => {
    if (composingRef.current || disabled || readOnly || variables === undefined) {
      setQuery(null);
      return;
    }
    setQuery(getSuggestionQuery(next, caret));
    setActiveIndex(0);
  };

  const handleValueChange = (next: string, target: HTMLTextAreaElement): void => {
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
    programmaticEdit.current = true;
    textarea.setRangeText(insert, start, end, "end");
    programmaticEdit.current = false;
    const targetSelection = selectionAfter ?? { start: start + insert.length, end: start + insert.length };
    selection.current = targetSelection;
    selectionAfterValue.current = { value: nextValue, range: targetSelection, focus: true };
    onChange(nextValue);
    setQuery(null);
    combobox.closeDropdown();
  };

  const chooseSuggestion = (variableName: string): void => {
    const currentQuery = query;
    if (currentQuery === null) return;
    const parameter = variables?.find((variable) => variable.name === variableName)?.parameter;
    insertText(`{${variableName}${parameter === undefined ? "" : ` ${parameter.value}`}}`, currentQuery.start - 1, currentQuery.end);
  };

  const onCompositionEnd = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    composingRef.current = false;
    setComposing(false);
    handleValueChange(event.currentTarget.value, event.currentTarget);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const native = event.nativeEvent;
    const isComposing = composingRef.current || native.isComposing || isLegacyCompositionKey(native);
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      if (isComposing) return;
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (isComposing) return;
    if (suggestionOpen && suggestions.length > 0 && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (suggestionOpen && suggestions.length > 0 && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
    } else if (suggestionOpen && event.key === "Enter" && activeSuggestion !== undefined) {
      event.preventDefault();
      chooseSuggestion(activeSuggestion.name);
    } else if (suggestionOpen && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery(null);
      combobox.closeDropdown();
    } else if (suggestionOpen && (event.key === "}" || event.key === " ")) {
      setQuery(null);
      combobox.closeDropdown();
    }
  };

  useEffect(() => {
    if (composing) return;
    onIssuesChange?.({ unknown: unknownVariables, worstCaseExceeded });
  }, [composing, onIssuesChange, unknownVariables, worstCaseExceeded]);

  useEffect(() => {
    if (suggestionOpen) combobox.openDropdown();
    else combobox.closeDropdown();
  }, [combobox, suggestionOpen]);

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

  const description: ReactNode = (
    <div className="ui-template-text-field__description-content">
      <div className="ui-template-text-field__helper-row">
        <span><TruncatedText text={hint} />{describedHelper(null, disabledReason, `template-text-field-${id}`)}</span>
        {countNode}
      </div>
      <div className="ui-template-text-field__warnings" id={`${id}-warnings`} aria-live="polite">
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
                  <Button size="compact" variant="subtle" type="button" disabled={disabled || readOnly} onClick={() => insertText(`{${suggestion}}`, token.start, token.start + token.text.length)}>
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
      {preview === undefined || previewLabel === undefined || previewSpeaker === undefined ? null : (
        <ChatPreview label={previewLabel} speaker={previewSpeaker} text={previewText ?? ""} countLabel={messages.previewCountLabel(previewCount)} />
      )}
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
    <Combobox
      store={combobox}
      onOptionSubmit={chooseSuggestion}
      withinPortal
      position="bottom-start"
      hideDetached={false}
      middlewares={{ flip: true, shift: true }}
      shadow="xs"
      width="min(400px, calc(100vw - 24px))"
    >
      <Input.Wrapper
        data-ui=""
        className="ui-template-text-field"
        id={id}
        label={label}
        description={description}
        descriptionProps={{ component: "div" }}
        inputWrapperOrder={["label", "input", "description", "error"]}
        error={effectiveError === undefined ? undefined : <span><span aria-hidden="true">× </span><TruncatedText text={effectiveError} /></span>}
        withAsterisk={required}
      >
        <div ref={frameRef} className="template-text-field" data-composing={composing ? "true" : undefined} data-readonly={readOnly ? "true" : undefined}>
          <RichTextarea
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
            onKeyDown={handleKeyDown}
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
            aria-activedescendant={suggestionOpen && activeSuggestion !== undefined ? `${listboxId}-${activeSuggestion.name}` : undefined}
            spellCheck
          >
            {renderDecoratedValue}
          </RichTextarea>
          <Combobox.Target withKeyboardNavigation={false} withAriaAttributes={false}>
            <span aria-hidden="true" className="template-text-field__caret-anchor" style={{ left: caretAnchor.left, top: caretAnchor.top }} />
          </Combobox.Target>
        </div>
      </Input.Wrapper>
      {suggestionOpen ? (
        <Combobox.Dropdown data-ui="" className="ui-template-text-field__suggestions-dropdown">
          <Combobox.Options id={listboxId} className="ui-template-text-field__suggestions" role="listbox" aria-label={(messages.picker ?? fallbackPickerMessages).title}>
            {suggestionGroups.map(({ group, options: groupOptions }) => (
              <Combobox.Group key={group.id} label={<TemplateTextFieldGroupHeading group={group} />}>
                {groupOptions.map(({ option: variable, index }) => (
                  <Combobox.Option
                    id={`${listboxId}-${variable.name}`}
                    key={variable.name}
                    value={variable.name}
                    active={index === activeIndex}
                    className="ui-template-text-field__suggestion"
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => { event.preventDefault(); }}
                  >
                    <span className="ui-template-text-field__suggestion-copy">
                      <span className="ui-template-text-field__suggestion-name">{variable.label ?? variable.name}</span>
                      <span className="ui-template-text-field__suggestion-token">{`{${variable.name}${variable.parameter === undefined ? "" : ` ${variable.parameter.value}`}}`}</span>
                      {index === activeIndex ? <span className="ui-template-text-field__suggestion-description">{variable.description}</span> : null}
                    </span>
                    <span className={`ui-template-text-field__suggestion-sample${variable.isTextBlock ? " ui-template-text-field__suggestion-sample--tag" : ""}`}>
                      {variable.sample}
                    </span>
                    {variable.external ? (
                      <span className="ui-template-text-field__suggestion-external" role="img" title={(messages.picker ?? fallbackPickerMessages).externalHelp} aria-label={(messages.picker ?? fallbackPickerMessages).externalHelp}>
                        <Icon name="cause" size={16} />
                      </span>
                    ) : null}
                  </Combobox.Option>
                ))}
              </Combobox.Group>
            ))}
            {suggestions.length === 0 ? <Combobox.Empty className="ui-template-text-field__no-results">{(messages.picker ?? fallbackPickerMessages).noResults}</Combobox.Empty> : null}
          </Combobox.Options>
          <TemplateTextFieldKeyboardHints messages={messages.picker ?? fallbackPickerMessages} />
        </Combobox.Dropdown>
      ) : null}
    </Combobox>
  );
}
