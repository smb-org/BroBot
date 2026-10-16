import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import { API_SOURCE_FUNCTION_CATALOG, type ApiSourceFunctionGroup } from "../contracts/function-catalog";
import type { ModuleLanguage } from "../../contract";
import { InlineSuggestionPicker, InlineSuggestionPickerTarget, Textarea, type InlineSuggestionPickerMessages } from "../../../dashboard/ui";
import { insertTextareaText } from "../../../dashboard/ui/textarea-insertion";
import { apiSourceFunctionAtCaret, expressionFunctionQueryAtCaret, expressionHasCallOpeningParenthesis, groupApiSourceFunctions } from "./expression-field-model";

export interface ExpressionFieldMessages {
  picker: InlineSuggestionPickerMessages;
  groupLabels: Readonly<Record<ApiSourceFunctionGroup, string>>;
  signatureLabel: string;
  insertionLimit: string;
}

interface ExpressionFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  language: ModuleLanguage;
  messages: ExpressionFieldMessages;
  disabled?: boolean;
}

interface PendingSelection {
  value: string;
  caret: number;
}

const isLegacyCompositionKey = (event: object): boolean => Reflect.get(event, "keyCode") === 229;

export function ExpressionField({ id, label, value, onChange, maxLength, language, messages, disabled = false }: ExpressionFieldProps): ReactElement {
  const generatedId = useId();
  const fieldId = id || `expression-${generatedId}`;
  const listboxId = `${fieldId}-functions`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<PendingSelection | null>(null);
  const dismissedQuery = useRef<string | null>(null);
  const programmaticEdit = useRef(false);
  const [caret, setCaret] = useState(0);
  const [query, setQuery] = useState<ReturnType<typeof expressionFunctionQueryAtCaret>>(null);
  const [insertionLimitReached, setInsertionLimitReached] = useState(false);
  const localizedFunctions = useMemo(
    () => groupApiSourceFunctions(API_SOURCE_FUNCTION_CATALOG, language, messages.groupLabels, query?.fragment ?? ""),
    [language, messages.groupLabels, query],
  );
  const activeFunction = apiSourceFunctionAtCaret(value, caret, API_SOURCE_FUNCTION_CATALOG);
  const pickerOpen = !disabled && query !== null;

  const updateSelectionState = (next: string, nextCaret: number): void => {
    setCaret(nextCaret);
    const nextQuery = disabled ? null : expressionFunctionQueryAtCaret(next, nextCaret);
    const queryKey = nextQuery === null ? null : `${String(nextQuery.start)}:${String(nextQuery.end)}:${nextQuery.fragment}`;
    if (dismissedQuery.current !== null) {
      if (queryKey === dismissedQuery.current) {
        setQuery(null);
        return;
      }
      dismissedQuery.current = null;
    }
    setQuery(nextQuery);
  };

  const rememberSelection = (target: HTMLTextAreaElement): void => {
    updateSelectionState(target.value, target.selectionStart);
  };

  const insertFunction = (name: string): void => {
    const target = textareaRef.current;
    if (target === null || disabled || query === null) return;
    const insertion = `$${name}${expressionHasCallOpeningParenthesis(target.value, query.end) ? "" : "("}`;
    const next = `${target.value.slice(0, query.start)}${insertion}${target.value.slice(query.end)}`;
    if (next.length > maxLength) {
      setInsertionLimitReached(true);
      return;
    }
    programmaticEdit.current = true;
    const { caret: nextCaret } = insertTextareaText(target, insertion, query.start, query.end);
    programmaticEdit.current = false;
    setInsertionLimitReached(false);
    pendingSelection.current = { value: next, caret: nextCaret };
    updateSelectionState(next, nextCaret);
    onChange(next);
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    handlePickerKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean,
  ): void => {
    const native = event.nativeEvent;
    if (native.isComposing || isLegacyCompositionKey(native)) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
      return;
    }
    handlePickerKeyDown(event);
  };

  useEffect(() => {
    const selection = pendingSelection.current;
    if (selection === null || selection.value !== value) return;
    pendingSelection.current = null;
    const target = textareaRef.current;
    if (target === null) return;
    target.focus();
    if (target.selectionStart !== selection.caret || target.selectionEnd !== selection.caret) {
      target.setSelectionRange(selection.caret, selection.caret);
    }
  }, [value]);

  return (
    <InlineSuggestionPicker
      listboxId={listboxId}
      open={pickerOpen}
      groups={localizedFunctions}
      messages={messages.picker}
      onSelect={insertFunction}
      onClose={() => {
        dismissedQuery.current = query === null ? null : `${String(query.start)}:${String(query.end)}:${query.fragment}`;
        setQuery(null);
      }}
      renderOption={(entry, active) => <>
        <span className="ui-template-text-field__suggestion-copy">
          <span className="ui-template-text-field__suggestion-name">{entry.name}</span>
          <span className="ui-template-text-field__suggestion-token">{`$${entry.signature}`}</span>
          {active ? <span className="ui-template-text-field__suggestion-description">{entry.localizedDescription}</span> : null}
        </span>
        <span className="ui-template-text-field__suggestion-sample">{entry.example}</span>
      </>}
    >
      {({ activeOptionId, handleKeyDown: handlePickerKeyDown }) => (
        <div data-ui="" className="ui-expression-field">
          <InlineSuggestionPickerTarget>
            <Textarea
              ref={textareaRef}
              id={fieldId}
              aria-label={label}
              aria-autocomplete="list"
              aria-expanded={pickerOpen}
              aria-controls={pickerOpen ? listboxId : undefined}
              aria-activedescendant={pickerOpen ? activeOptionId : undefined}
              className="ui-expression-field__input mono"
              rows={14}
              maxLength={maxLength}
              spellCheck={false}
              value={value}
              disabled={disabled}
              onChange={(event) => {
                const target = event.currentTarget;
                if (programmaticEdit.current) {
                  programmaticEdit.current = false;
                  return;
                }
                setInsertionLimitReached(false);
                onChange(target.value);
                updateSelectionState(target.value, target.selectionStart);
              }}
              onSelect={(event) => { rememberSelection(event.currentTarget); }}
              onClick={(event) => { rememberSelection(event.currentTarget); }}
              onFocus={(event) => { rememberSelection(event.currentTarget); }}
              onKeyUp={(event) => { rememberSelection(event.currentTarget); }}
              onKeyDown={(event) => { handleKeyDown(event, handlePickerKeyDown); }}
              onBlur={() => { setQuery(null); }}
            />
          </InlineSuggestionPickerTarget>
          <div className="ui-expression-field__signature" aria-live="polite" aria-label={messages.signatureLabel}>
            {insertionLimitReached ? <span role="status" className="ui-expression-field__limit">{messages.insertionLimit}</span>
              : activeFunction === null ? <span aria-hidden="true">&nbsp;</span> : <code>{`$${activeFunction.signature}`}</code>}
          </div>
        </div>
      )}
    </InlineSuggestionPicker>
  );
}
