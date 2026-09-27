import { Drawer, Popover as MantinePopover, TextInput } from "@mantine/core";
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import { Button } from "./Button";
import { Icon } from "./Icon";
import {
  filterTemplateVariableOptions,
  groupTemplateVariableOptions,
  prioritizeTemplateVariableNamespace,
  reindexGroupedTemplateVariableOptions,
  type TemplateVariablePickerGroupPresentation,
  type TemplateVariablePickerMessages,
  type TemplateVariablePickerOption,
} from "./template-variable-picker-model";

export type {
  TemplateVariablePickerGroup,
  TemplateVariablePickerGroupKey,
  TemplateVariablePickerGroupPresentation,
  TemplateVariablePickerKind,
  TemplateVariablePickerMessages,
  TemplateVariablePickerOption,
} from "./template-variable-picker-model";

import "./TemplateVariablePicker.css";

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
  /** Desired selection after insertion; the parameter range when present. */
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
  opened: suppliedOpened,
  onOpenedChange,
  disabled = false,
}: TemplateVariablePickerProps): ReactElement {
  const generatedId = useId();
  const panelId = `template-variable-picker-${generatedId}`;
  const popoverPanelId = `${panelId}-popover`;
  const sheetPanelId = `${panelId}-sheet`;
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());
  const [internalOpened, setInternalOpened] = useState(false);
  const opened = suppliedOpened ?? internalOpened;
  const [isSmallScreen, setIsSmallScreen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 599px)");
    const update = (): void => setIsSmallScreen(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const filteredOptions = useMemo(() => filterTemplateVariableOptions(options, query), [options, query]);
  const groups = useMemo(() => reindexGroupedTemplateVariableOptions(prioritizeTemplateVariableNamespace(
    groupTemplateVariableOptions(filteredOptions, messages, createVariableHref !== undefined),
    query,
  )), [createVariableHref, filteredOptions, messages, query]);
  const orderedOptions = useMemo(() => groups.flatMap(({ options: groupOptions }) => groupOptions), [groups]);

  const changeOpened = (nextOpened: boolean): void => {
    if (nextOpened !== opened) {
      setQuery("");
      setActiveIndex(0);
    }
    if (suppliedOpened === undefined) setInternalOpened(nextOpened);
    onOpenedChange?.(nextOpened);
  };

  useEffect(() => {
    if (!opened) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [opened, isSmallScreen]);

  useEffect(() => {
    optionRefs.current.get(activeIndex)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const closeAndReturnToEditor = (returnFocus: boolean): void => {
    changeOpened(false);
    if (returnFocus) window.requestAnimationFrame(() => focusEditor());
  };

  const choose = (option: TemplateVariablePickerOption): void => {
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
    onInsert({ option, text, replaceRange, selectionRange, parameterRange });
    closeAndReturnToEditor(false);
    window.requestAnimationFrame(() => {
      focusEditor();
      setEditorSelection(selectionRange);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndReturnToEditor(true);
      return;
    }
    if (orderedOptions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % orderedOptions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + orderedOptions.length) % orderedOptions.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(orderedOptions.length - 1);
    } else if (event.key === "Enter") {
      const entry = orderedOptions[activeIndex];
      if (entry !== undefined) {
        event.preventDefault();
        choose(entry.option);
      }
    }
  };

  const renderContent = (surface: "popover" | "sheet"): ReactElement => {
    const surfacePanelId = surface === "sheet" ? sheetPanelId : popoverPanelId;
    const searchId = `${surfacePanelId}-search`;
    const listId = `${surfacePanelId}-list`;
    const activeEntry = orderedOptions[activeIndex];
    const activeOptionId = activeEntry === undefined ? undefined : `${listId}-${String(activeEntry.index)}`;
    return (
      <div id={surfacePanelId} className={`ui-variable-picker${surface === "sheet" ? " ui-variable-picker--sheet" : ""}`}>
        {isSmallScreen ? (
          <div className="ui-variable-picker__mobile-header">
            <span className="ui-variable-picker__handle" aria-hidden="true" />
            <h2>{messages.title}</h2>
            <Button icon="close" iconOnly ariaLabel={messages.closeLabel} variant="subtle" onClick={() => closeAndReturnToEditor(false)} />
          </div>
        ) : null}
        <TextInput
          ref={searchRef}
          id={searchId}
          className="ui-variable-picker__search"
          aria-label={messages.searchLabel}
          placeholder={messages.searchLabel}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeOptionId}
          leftSection={<Icon name="search" size={16} />}
          value={query}
          onChange={(event) => { setQuery(event.currentTarget.value); setActiveIndex(0); }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />
        <div id={listId} className="ui-variable-picker__list" role="listbox" aria-label={messages.title}>
          {groups.map(({ group, options: groupOptions }) => (
            <div className="ui-variable-picker__group" role="group" aria-label={group.label} key={group.id}>
              <h3 className="ui-variable-picker__group-heading"><TemplateVariableGroupHeading group={group} /></h3>
              {groupOptions.map(({ option, index }) => (
                <button
                  type="button"
                  id={`${listId}-${String(index)}`}
                  key={`${group.id}-${option.name}`}
                  ref={(element) => {
                    if (element === null) optionRefs.current.delete(index);
                    else optionRefs.current.set(index, element);
                  }}
                  className="ui-variable-picker__option"
                  role="option"
                  aria-selected={activeIndex === index}
                  data-kind={option.kind}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(option)}
                >
                  <span className="ui-variable-picker__option-copy">
                    <span className="ui-variable-picker__label">{option.label ?? option.name}</span>
                    <span className="ui-variable-picker__token">{tokenFor(option)}</span>
                    {activeIndex === index ? <span className="ui-variable-picker__description">{option.description}</span> : null}
                  </span>
                  <span className={`ui-variable-picker__sample${option.isTextBlock ? " ui-variable-picker__sample--tag" : ""}`}>
                    {option.isTextBlock ? messages.textBlockSample : option.sample}
                  </span>
                  {option.external === true ? (
                    <span className="ui-variable-picker__external" role="img" title={messages.externalHelp} aria-label={messages.externalHelp}>
                      <Icon name="cause" size={16} />
                    </span>
                  ) : null}
                </button>
              ))}
              {group.id === "host:channel" && createVariableHref !== undefined ? (
                <a className="ui-variable-picker__create" href={createVariableHref}>{messages.createVariableLabel}</a>
              ) : null}
            </div>
          ))}
          {orderedOptions.length === 0 && createVariableHref === undefined ? (
            <p className="ui-variable-picker__empty">{messages.noResults}</p>
          ) : null}
        </div>
        <TemplateVariableKeyboardHints messages={messages} />
      </div>
    );
  };

  return (
    <>
      <MantinePopover
        opened={opened && !isSmallScreen}
        onChange={changeOpened}
        withinPortal
        position="bottom-end"
        width={360}
        shadow="xs"
        closeOnEscape={false}
        closeOnClickOutside
      >
        <MantinePopover.Target>
          <button
            type="button"
            className="ui-variable-picker__trigger"
            aria-label={messages.triggerLabel}
            aria-haspopup="dialog"
            aria-expanded={opened}
            aria-controls={isSmallScreen ? sheetPanelId : popoverPanelId}
            disabled={disabled}
            onClick={() => changeOpened(!opened)}
          >
            <Icon name="variable" size={20} />
          </button>
        </MantinePopover.Target>
        <MantinePopover.Dropdown role="dialog" aria-label={messages.title} className="ui-variable-picker__popover">
          {renderContent("popover")}
        </MantinePopover.Dropdown>
      </MantinePopover>
      <Drawer
        opened={opened && isSmallScreen}
        onClose={() => closeAndReturnToEditor(false)}
        position="bottom"
        withCloseButton={false}
        overlayProps={{ backgroundOpacity: 0.35, blur: 1 }}
        classNames={{ content: "ui-variable-picker__drawer-content", body: "ui-variable-picker__drawer-body" }}
        withinPortal
        aria-label={messages.title}
      >
        {renderContent("sheet")}
      </Drawer>
    </>
  );
}
