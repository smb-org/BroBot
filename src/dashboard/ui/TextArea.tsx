import { Combobox, Input, Pill, useCombobox } from "@mantine/core";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";

import { closestTemplateVariable, tokenizeTemplate, unknownTemplateVariables, type TemplateVariable } from "../../template";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { templateHighlightParts } from "./template-highlight";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";

export interface TemplateVariableOption {
  name: string;
  description: string;
  sample: string;
}

export interface TextAreaMessages {
  countLabel: (count: number, maxLength: number) => string;
  previewCountLabel: (count: number) => ReactNode;
  unknownVariable: (name: string, suggestion: string | null, available: readonly string[]) => ReactNode;
  insertSuggestionLabel: (name: string) => string;
  worstCaseLength: (length: number, maxLength: number) => ReactNode;
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
  required?: boolean;
  minRows?: number;
  id?: string;
  name?: string;
  messages: TextAreaMessages;
}

interface SuggestionQuery {
  fragment: string;
  start: number;
  end: number;
}

const templateDeclarations = (options: readonly TemplateVariableOption[]): TemplateVariable[] =>
  options.map((option) => ({ name: option.name, sample: option.sample, maxLength: 0 }));

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
  required = false,
  minRows = 4,
  id: suppliedId,
  name,
  messages,
}: TextAreaProps): ReactElement {
  const generatedId = useId();
  const disabledReason = useDisabledFieldReason();
  const id = suppliedId ?? `template-${generatedId}`;
  const listboxId = `${id}-suggestions`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [query, setQuery] = useState<SuggestionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const declarations = useMemo(() => templateDeclarations(variables ?? []), [variables]);
  const variableNames = variables?.map((variable) => variable.name) ?? [];
  const count = value.length;
  const overLimit = maxLength !== undefined && count > maxLength;
  const nearLimit = maxLength !== undefined && count >= maxLength * 0.9;
  const effectiveError = error ?? (maxLength !== undefined && count > maxLength ? messages.countLabel(count, maxLength) : undefined);
  const worstCase = suppliedWorstCaseLength;
  const worstCaseExceeded = maxLength !== undefined && worstCase !== undefined && worstCase > maxLength;
  const unknownVariables = useMemo(() => variables === undefined ? [] : unknownTemplateVariables(value, declarations), [declarations, value, variables]);
  const unknownPieces = useMemo(() => variables === undefined ? [] : tokenizeTemplate(value, declarations).filter((part) => part.kind === "unknown"), [declarations, value, variables]);
  const deferredValue = useDeferredValue(value);
  const previewText = preview === undefined ? undefined : preview(deferredValue, Object.fromEntries((variables ?? []).map((variable) => [variable.name, variable.sample])));
  const previewCount = previewText?.length ?? 0;
  const suggestions = query === null || variables === undefined
    ? []
    : variables.filter((variable) => variable.name.toLowerCase().startsWith(query.fragment.toLowerCase()));
  const suggestionOpen = suggestions.length > 0;
  const activeSuggestion = suggestions[activeIndex] ?? suggestions[0];
  const pieces = useMemo(() => templateHighlightParts(value, declarations, query), [declarations, query, value]);
  const unknownAdvice = useMemo(() => unknownVariables.map((tokenName) => ({
    tokenName,
    suggestion: closestTemplateVariable(tokenName, declarations),
  })), [declarations, unknownVariables]);
  const combobox = useCombobox({
    onDropdownClose: () => { setActiveIndex(0); },
  });

  useEffect(() => {
    if (typeof document === "undefined" || !("fonts" in document)) return;
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) setFontsReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (composing) return;
    onIssuesChange?.({ unknown: unknownVariables, worstCaseExceeded });
  }, [composing, onIssuesChange, unknownVariables, worstCaseExceeded]);

  useEffect(() => {
    if (suggestionOpen) combobox.openDropdown();
    else combobox.closeDropdown();
  }, [combobox, suggestionOpen]);

  const rememberSelection = (target: HTMLTextAreaElement): void => {
    selection.current = { start: target.selectionStart, end: target.selectionEnd };
  };

  const handleValueChange = (next: string, target: HTMLTextAreaElement): void => {
    onChange(next);
    rememberSelection(target);
    const nextQuery = getSuggestionQuery(next, target.selectionStart);
    setQuery(nextQuery);
    setActiveIndex(0);
  };

  const insertText = (insert: string, start: number, end: number): void => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.setRangeText(insert, start, end, "end");
    onChange(textarea.value);
    const caret = start + insert.length;
    selection.current = { start: caret, end: caret };
    setQuery(getSuggestionQuery(textarea.value, caret));
    combobox.closeDropdown();
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
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
                <span>{messages.unknownVariable(tokenName, suggestion, variableNames)}</span>
                {suggestion === null || token === undefined ? null : (
                  <Button size="compact" variant="subtle" type="button" onClick={() => insertText(`{${suggestion}}`, token.start, token.start + token.text.length)}>
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
      {variables === undefined ? null : (
        <div className="ui-textarea__chips">
          {variables.map((variable) => (
            <Pill key={variable.name} className="ui-textarea__chip" size="sm" withRemoveButton={false}>
              <button
                type="button"
                title={variable.description}
                aria-description={variable.description}
                disabled={disabled}
                onClick={() => {
                  const saved = selection.current;
                  insertText(`{${variable.name}}`, saved.start, saved.end);
                }}
              >{`{${variable.name}}`}</button>
            </Pill>
          ))}
        </div>
      )}
      {preview === undefined || previewLabel === undefined || previewSpeaker === undefined ? null : (
        <div className="ui-textarea__preview">
          <span className="ui-textarea__preview-label">{previewLabel}</span>
          <span className="ui-textarea__preview-speaker">{previewSpeaker}</span>
          <span className="ui-textarea__preview-text">{previewText}</span>
          <span className="ui-textarea__preview-count">{messages.previewCountLabel(previewCount)}</span>
        </div>
      )}
    </div>
  );

  const mirror = variables === undefined || !fontsReady ? null : (
    <div className="template-field__mirror" aria-hidden="true" ref={mirrorRef}>
      {pieces.map((part) => (
        <span key={`${String(part.start)}-${part.kind}`} data-kind={part.kind} data-start={part.start}>{part.text}</span>
      ))}
      {value.endsWith("\n") ? <span aria-hidden="true">{"\u200b"}</span> : null}
    </div>
  );

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={chooseSuggestion}
      withinPortal={false}
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
        <Combobox.Target>
          <div className="template-field" data-composing={composing ? "true" : undefined} data-highlight-ready={variables !== undefined && fontsReady ? "true" : "false"}>
            {mirror}
            <Input
              component="textarea"
              multiline
              variant="unstyled"
              className="template-field__input"
              styles={{ input: { backgroundColor: "transparent", border: 0, boxShadow: "none" } }}
              ref={textareaRef}
              value={value}
              onChange={(event) => { handleValueChange(event.currentTarget.value, event.currentTarget); }}
              onScroll={(event) => {
                const mirrorElement = mirrorRef.current;
                if (mirrorElement === null) return;
                mirrorElement.scrollTop = event.currentTarget.scrollTop;
                mirrorElement.scrollLeft = event.currentTarget.scrollLeft;
              }}
              onSelect={(event) => {
                rememberSelection(event.currentTarget);
                setQuery(getSuggestionQuery(value, event.currentTarget.selectionStart));
                setActiveIndex(0);
              }}
              onClick={(event) => { rememberSelection(event.currentTarget); }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
              onCompositionEnd={onCompositionEnd}
              id={id}
              name={name}
              rows={minRows}
              required={required}
              disabled={disabled}
              error={effectiveError !== undefined}
              aria-autocomplete="list"
              aria-expanded={suggestionOpen}
              aria-controls={suggestionOpen ? listboxId : undefined}
              aria-activedescendant={suggestionOpen && activeSuggestion !== undefined ? `${listboxId}-${activeSuggestion.name}` : undefined}
              spellCheck
            />
          </div>
        </Combobox.Target>
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
