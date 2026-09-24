import { Combobox, Input, useCombobox } from "@mantine/core";
import { RichTextarea, type CaretPosition, type RichTextareaHandle } from "rich-textarea";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";

import { closestTemplateVariable, tokenizeTemplate, unknownTemplateVariables, type TemplateVariable } from "../../template";
import type { TemplateVariableGroup } from "../../contracts/values";
import { Button } from "./Button";
import { ChatPreview } from "./ChatPreview";
import { Icon } from "./Icon";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";
import { TemplateVariablePicker, type TemplateVariablePickerMessages, type TemplateVariablePickerOption, type TemplateVariablePickerRange } from "./TemplateVariablePicker";

export interface TemplateVariableOption {
  name: string;
  description: string;
  sample: string;
  group?: TemplateVariableGroup;
  kind?: "system" | "module" | "channel";
  external?: boolean;
  parameters?: NonNullable<TemplateVariable["parameters"]>;
  parameter?: { value: string };
}

export interface TextAreaMessages {
  countLabel: (count: number, maxLength: number) => string;
  previewCountLabel: (count: number) => ReactNode;
  unknownVariable: (name: string, suggestion: string | null) => ReactNode;
  insertSuggestionLabel: (name: string) => string;
  worstCaseLength: (length: number, maxLength: number) => ReactNode;
  variablePicker?: TemplateVariablePickerMessages;
}

export interface TextAreaProps {
  label: string;
  hint: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  worstCaseLength?: number;
  variables?: readonly TemplateVariableOption[];
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
  messages: TextAreaMessages;
  createVariableHref?: string;
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

const templateDeclarations = (options: readonly TemplateVariableOption[]): TemplateVariable[] =>
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
  const match = /\{([A-Za-z0-9_]*)$/u.exec(prefix);
  if (match === null) return null;
  return { fragment: match[1] ?? "", start: match.index + 1, end: caret };
};

const isLegacyCompositionKey = (event: object): boolean => Reflect.get(event, "keyCode") === 229;

export function TextArea({
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
  createVariableHref,
}: TextAreaProps): ReactElement {
  const generatedId = useId();
  const disabledReason = useDisabledFieldReason();
  const id = suppliedId ?? `template-${generatedId}`;
  const listboxId = `${id}-suggestions`;
  const textareaRef = useRef<RichTextareaHandle>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const programmaticEdit = useRef(false);
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const [query, setQuery] = useState<SuggestionQuery | null>(null);
  const [caretAnchor, setCaretAnchor] = useState<CaretAnchor>({ left: 12, top: 32 });
  const [activeIndex, setActiveIndex] = useState(0);
  const [variablePickerOpen, setVariablePickerOpen] = useState(false);
  const declarations = useMemo(() => templateDeclarations(variables ?? []), [variables]);
  const count = value.length;
  const overLimit = maxLength !== undefined && count > maxLength;
  const nearLimit = maxLength !== undefined && count >= maxLength * 0.9;
  const effectiveError = error ?? (overLimit ? messages.countLabel(count, maxLength) : undefined);
  const worstCase = suppliedWorstCaseLength;
  const worstCaseExceeded = maxLength !== undefined && worstCase !== undefined && worstCase > maxLength;
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
  const suggestions = query === null || variables === undefined
    ? []
    : variables.filter((variable) => variable.name.toLowerCase().startsWith(query.fragment.toLowerCase()));
  const suggestionOpen = !disabled && !readOnly && !composing && suggestions.length > 0;
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
    onChange(next);
    rememberSelection(target);
    const caret = target.selectionStart === 0 && target.selectionEnd === 0 && next.length > value.length
      ? next.length
      : target.selectionStart;
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

  const insertText = (insert: string, start: number, end: number, selectionAfter?: TemplateVariablePickerRange): void => {
    const textarea = textareaRef.current;
    if (textarea === null || disabled || readOnly) return;
    const nextValue = `${textarea.value.slice(0, start)}${insert}${textarea.value.slice(end)}`;
    programmaticEdit.current = true;
    textarea.setRangeText(insert, start, end, "end");
    programmaticEdit.current = false;
    onChange(nextValue);
    const targetSelection = selectionAfter ?? { start: start + insert.length, end: start + insert.length };
    selection.current = targetSelection;
    setQuery(null);
    combobox.closeDropdown();
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(targetSelection.start, targetSelection.end);
    });
  };

  const chooseSuggestion = (variableName: string): void => {
    const currentQuery = query;
    if (currentQuery === null) return;
    insertText(`${variableName}}`, currentQuery.start, currentQuery.end);
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
    if ((event.ctrlKey || event.metaKey) && event.code === "Space") {
      event.preventDefault();
      setQuery(null);
      combobox.closeDropdown();
      setVariablePickerOpen(true);
      return;
    }
    if (isComposing) return;
    if (suggestionOpen && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (suggestionOpen && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
    } else if (suggestionOpen && (event.key === "Enter" || event.key === "Tab") && activeSuggestion !== undefined) {
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

  const countNode = maxLength === undefined ? null : (
    <span className={`ui-textarea__count${nearLimit && !overLimit ? " ui-textarea__count--warning" : ""}${overLimit ? " ui-textarea__count--error" : ""}`} id={`${id}-count`}>
      {messages.countLabel(count, maxLength)}
    </span>
  );

  const description: ReactNode = (
    <div className="ui-textarea__description-content">
      <div className="ui-textarea__helper-row">
        <span>{describedHelper(hint, disabledReason, `textarea-${id}`)}</span>
        {countNode}
      </div>
      {unknownAdvice.length > 0 || worstCaseExceeded ? (
        <div className="ui-textarea__warnings" id={`${id}-warnings`}>
          {unknownAdvice.map(({ tokenName, suggestion }, index) => {
            const token = unknownPieces.find((piece) => piece.text === `{${tokenName}}`);
            return (
              <div className="ui-textarea__warning" key={`${tokenName}-${String(index)}`}>
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
            <div className="ui-textarea__warning"><Icon name="warning" size={16} /><span>{messages.worstCaseLength(worstCase, maxLength)}</span></div>
          ) : null}
        </div>
      ) : null}
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
        : <span key={`${String(part.start)}-${part.kind}`} data-kind={part.kind} className={`template-field__decoration template-field__decoration--${part.kind}`}>{part.text}</span>
    ));

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={chooseSuggestion}
      withinPortal
      position="bottom-start"
      middlewares={{ flip: true, shift: true }}
      shadow="xs"
    >
      <Input.Wrapper
        className="ui-textarea"
        id={id}
        label={label}
        description={description}
        descriptionProps={{ component: "div" }}
        inputWrapperOrder={["label", "input", "description", "error"]}
        error={effectiveError === undefined ? undefined : `× ${effectiveError}`}
        withAsterisk={required}
      >
        <div ref={frameRef} className="template-field" data-composing={composing ? "true" : undefined} data-readonly={readOnly ? "true" : undefined}>
          <RichTextarea
            className="template-field__input"
            ref={textareaRef}
            style={{ width: "100%", paddingRight: 54 }}
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
              updateSuggestionQuery(value, event.currentTarget.selectionStart);
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
          {variables !== undefined && messages.variablePicker !== undefined ? (
            <div className="template-field__variable-picker">
              <TemplateVariablePicker
                options={variables.map((variable): TemplateVariablePickerOption => ({
                  name: variable.name,
                  description: variable.description,
                  sample: variable.sample,
                  group: variable.group ?? "context",
                  kind: variable.kind ?? "module",
                  ...(variable.external === undefined ? {} : { external: variable.external }),
                  ...(variable.parameter === undefined ? {} : { parameter: variable.parameter }),
                }))}
                messages={messages.variablePicker}
                opened={variablePickerOpen}
                onOpenedChange={setVariablePickerOpen}
                disabled={disabled || readOnly}
                {...(createVariableHref === undefined ? {} : { createVariableHref })}
                getSelection={() => selection.current}
                focusEditor={() => { textareaRef.current?.focus(); }}
                setEditorSelection={(range) => { selection.current = range; textareaRef.current?.setSelectionRange(range.start, range.end); }}
                onInsert={({ text: token, replaceRange, selectionRange }) => {
                  insertText(token, replaceRange.start, replaceRange.end, selectionRange);
                }}
              />
            </div>
          ) : null}
          <Combobox.Target withKeyboardNavigation={false} withAriaAttributes={false}>
            <span aria-hidden="true" className="template-field__caret-anchor" style={{ left: caretAnchor.left, top: caretAnchor.top }} />
          </Combobox.Target>
        </div>
      </Input.Wrapper>
      {suggestionOpen ? (
        <Combobox.Dropdown className="ui-textarea__suggestions-dropdown">
          <Combobox.Options id={listboxId} className="ui-textarea__suggestions" role="listbox">
            {suggestions.map((variable, index) => (
              <Combobox.Option
                id={`${listboxId}-${variable.name}`}
                key={variable.name}
                value={variable.name}
                active={index === activeIndex}
                className="ui-textarea__suggestion"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => { event.preventDefault(); }}
              >
                <span className="ui-textarea__suggestion-name mono">{variable.name}</span>
                <span className="ui-textarea__suggestion-description">{variable.description}</span>
              </Combobox.Option>
            ))}
          </Combobox.Options>
        </Combobox.Dropdown>
      ) : null}
    </Combobox>
  );
}
