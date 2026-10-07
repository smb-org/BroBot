import { useMemo, useRef, type ReactElement } from "react";

import { GroupedPicker, type GroupedPickerEntry, type GroupedPickerGroup } from "./GroupedPicker";
import { Icon } from "./Icon";
import {
  filterTemplateVariableOptions,
  groupTemplateVariableOptions,
  prioritizeTemplateVariableNamespace,
  type TemplateVariablePickerGroupPresentation,
  type TemplateVariablePickerMessages,
  type TemplateVariablePickerOption,
} from "./template-variable-picker-model";

import "./TemplateVariablePicker.css";

export type {
  TemplateVariablePickerGroup,
  TemplateVariablePickerGroupKey,
  TemplateVariablePickerGroupPresentation,
  TemplateVariablePickerKind,
  TemplateVariablePickerMessages,
  TemplateVariablePickerOption,
} from "./template-variable-picker-model";

export interface TemplateVariablePickerRange {
  start: number;
  end: number;
}

/** The details required to replace the editor selection and position the caret. */
export interface TemplateVariableInsertion {
  option: TemplateVariablePickerOption;
  /** Complete token, including braces. */
  text: string;
  /** Selection in the editor before insertion. */
  replaceRange: TemplateVariablePickerRange;
  /** Desired selection after the caller inserts; the parameter range when present. */
  selectionRange: TemplateVariablePickerRange;
  /** Range of the default parameter, relative to the complete editor value. */
  parameterRange: TemplateVariablePickerRange | null;
}

export interface TemplateVariablePickerProps {
  options: readonly TemplateVariablePickerOption[];
  messages: TemplateVariablePickerMessages;
  onInsert: (insertion: TemplateVariableInsertion) => void;
  /** Current textarea selection. The caller owns the editor and its value. */
  getSelection: () => TemplateVariablePickerRange | null;
  /** Restores editor focus after choosing or dismissing with Escape. */
  focusEditor: () => void;
  /** Applies the resulting caret/parameter selection after the caller inserts. */
  setEditorSelection: (range: TemplateVariablePickerRange) => void;
  /** When supplied, adds the management link at the end of the channel group. */
  createVariableHref?: string;
  /** Controlled visibility, allowing the editor shortcut to open the picker. */
  opened?: boolean;
  onOpenedChange?: (opened: boolean) => void;
  disabled?: boolean;
}

const tokenFor = (option: TemplateVariablePickerOption): string =>
  `{${option.name}${option.parameter === undefined ? "" : ` ${option.parameter.value}`}}`;

const GroupIcon = ({ group }: { group: TemplateVariablePickerGroupPresentation }): ReactElement => {
  if (group.iconPaths !== undefined) {
    return (
      <svg className="ui-variable-picker__group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {group.iconPaths.map((path, index) => <path key={`${group.id}-${String(index)}`} d={path} />)}
      </svg>
    );
  }
  return <Icon className="ui-variable-picker__group-icon" name={group.iconName ?? "variable"} size={16} />;
};

export const TemplateVariableGroupHeading = ({ group }: { group: TemplateVariablePickerGroupPresentation }): ReactElement => (
  <span className="ui-variable-picker__group-title">
    <GroupIcon group={group} />
    <span>{group.label}</span>
  </span>
);

export const TemplateVariableKeyboardHints = ({ messages }: { messages: TemplateVariablePickerMessages }): ReactElement => (
  <div className="ui-variable-picker__key-hints">
    <span className="ui-variable-picker__key-hint"><kbd>↑↓</kbd>{messages.keyHints.navigate}</span>
    <span className="ui-variable-picker__key-hint"><kbd>Enter</kbd>{messages.keyHints.insert}</span>
    <span className="ui-variable-picker__key-hint"><kbd>Esc</kbd>{messages.keyHints.close}</span>
  </div>
);

export function TemplateVariablePicker({
  options,
  messages,
  onInsert,
  getSelection,
  focusEditor,
  setEditorSelection,
  createVariableHref,
  opened,
  onOpenedChange,
  disabled = false,
}: TemplateVariablePickerProps): ReactElement {
  const pendingSelection = useRef<TemplateVariablePickerRange | null>(null);
  const sourceGroups = useMemo(
    () => groupTemplateVariableOptions(options, messages, createVariableHref !== undefined),
    [createVariableHref, messages, options],
  );
  const groups = useMemo<readonly GroupedPickerGroup<TemplateVariablePickerOption>[]>(() => sourceGroups.map(({ group, options: groupOptions }) => ({
    id: group.id,
    label: group.label,
    icon: <GroupIcon group={group} />,
    entries: groupOptions.map(({ option }) => ({
      id: option.name,
      label: option.label ?? option.name,
      description: option.description,
      icon: null,
      searchText: `${option.name} ${tokenFor(option)} ${group.label}`,
      // Fixed-width column so the info icon shares one x across rows; empty when absent.
      trailing: (
        <span className="ui-variable-picker__info">
          {option.external === true ? (
            <span className="ui-variable-picker__external" role="img" title={messages.externalHelp} aria-label={messages.externalHelp}>
              <Icon name="cause" size={16} />
            </span>
          ) : null}
        </span>
      ),
      value: option,
    })),
    footer: group.id === "host:channel" && createVariableHref !== undefined
      ? <a className="ui-variable-picker__create" href={createVariableHref}>{messages.createVariableLabel}</a>
      : undefined,
  })), [createVariableHref, messages, sourceGroups]);

  const transformGroups = (matchedGroups: readonly GroupedPickerGroup<TemplateVariablePickerOption>[], query: string): readonly GroupedPickerGroup<TemplateVariablePickerOption>[] => {
    const rankedOptions = filterTemplateVariableOptions(options, query);
    const rank = new Map(rankedOptions.map((option, index) => [option, index]));
    const groupOrder = new Map(prioritizeTemplateVariableNamespace(sourceGroups, query).map(({ group }, index) => [group.id, index]));
    const optionRank = (entry: GroupedPickerEntry<TemplateVariablePickerOption>): number =>
      entry.value === undefined ? Number.MAX_SAFE_INTEGER : rank.get(entry.value) ?? Number.MAX_SAFE_INTEGER;
    return matchedGroups.map((group) => ({
      ...group,
      entries: [...group.entries].sort((left, right) => optionRank(left) - optionRank(right)),
    })).sort((left, right) => (groupOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (groupOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  };

  const restoreEditorFocus = (): void => {
    focusEditor();
    const selection = pendingSelection.current;
    if (selection !== null) {
      setEditorSelection(selection);
      pendingSelection.current = null;
    }
  };

  const choose = (entry: GroupedPickerEntry<TemplateVariablePickerOption>): void => {
    const option = entry.value;
    if (option === undefined) return;
    const replaceRange = getSelection() ?? { start: 0, end: 0 };
    const text = tokenFor(option);
    const insertedStart = replaceRange.start;
    const insertedEnd = insertedStart + text.length;
    const parameterRange = option.parameter === undefined
      ? null
      : {
        start: insertedStart + 1 + option.name.length + 1,
        end: insertedStart + 1 + option.name.length + 1 + option.parameter.value.length,
      };
    const selectionRange = parameterRange ?? { start: insertedEnd, end: insertedEnd };
    pendingSelection.current = selectionRange;
    onInsert({ option, text, replaceRange, selectionRange, parameterRange });
  };

  return (
    <GroupedPicker
      groups={groups}
      messages={{
        title: messages.title,
        searchLabel: messages.searchLabel,
        closeLabel: messages.closeLabel,
        noResults: messages.noResults,
        keyHints: { navigate: messages.keyHints.navigate, choose: messages.keyHints.insert, close: messages.keyHints.close },
      }}
      trigger={(
        <button type="button" className="ui-variable-picker__trigger" aria-label={messages.triggerLabel} disabled={disabled}>
          <Icon name="variable" size={20} />
        </button>
      )}
      {...(opened === undefined ? {} : { opened })}
      {...(onOpenedChange === undefined ? {} : { onOpenedChange })}
      disabled={disabled}
      onSelect={choose}
      onDismissFocus={restoreEditorFocus}
      renderActiveDetail={(entry) => entry.value?.description}
      renderEntryContent={(entry) => {
        const option = entry.value;
        return (
          <span className="ui-variable-picker__option-copy">
            <span className="ui-variable-picker__label">{entry.label}</span>
            {option === undefined ? null : (
              <span className="ui-variable-picker__token-line">
                <span className="ui-variable-picker__token">{tokenFor(option)}</span>
                <span className={`ui-variable-picker__sample${option.isTextBlock ? " ui-variable-picker__sample--tag" : ""}`} data-testid="variable-sample">
                  {option.isTextBlock ? messages.textBlockSample : option.sample}
                </span>
              </span>
            )}
          </span>
        );
      }}
      transformGroups={transformGroups}
      showNoResults={createVariableHref === undefined}
      width="min(440px, calc(100vw - 32px))"
    />
  );
}
