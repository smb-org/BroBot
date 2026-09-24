import { Drawer, Popover as MantinePopover, TextInput } from "@mantine/core";
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import {
  TEMPLATE_VARIABLE_GROUPS,
  type TemplateVariableGroup,
  type TemplateVariableSource,
} from "../../contracts/values";
import { Button } from "./Button";
import { Icon } from "./Icon";

import "./TemplateVariablePicker.css";

export type TemplateVariablePickerGroup = TemplateVariableGroup;

export type TemplateVariablePickerKind = TemplateVariableSource;

export interface TemplateVariablePickerOption {
  /** Canonical variable name, without braces. */
  name: string;
  /** Short description in the active dashboard language. */
  description: string;
  /** Example or current channel value in the active dashboard language. */
  sample: string;
  group: TemplateVariablePickerGroup;
  kind: TemplateVariablePickerKind;
  /** Helix-backed variables make a Twitch request when the command runs. */
  external?: boolean;
  /** Default parameter text to select after inserting a parameterized token. */
  parameter?: { value: string };
}

export interface TemplateVariablePickerMessages {
  triggerLabel: string;
  title: string;
  searchLabel: string;
  closeLabel: string;
  noResults: string;
  createVariableLabel: string;
  externalHelp: string;
  groupLabels: Readonly<Record<TemplateVariablePickerGroup, string>>;
}

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

const groupOrder: readonly TemplateVariablePickerGroup[] = TEMPLATE_VARIABLE_GROUPS;

const normalizeSearch = (value: string): string => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/gu, "")
  .toLowerCase();

const tokenFor = (option: TemplateVariablePickerOption): string =>
  `{${option.name}${option.parameter === undefined ? "" : ` ${option.parameter.value}`}}`;

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

  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeSearch(query.trim());
    if (normalizedQuery.length === 0) return options;
    return options.filter((option) => normalizeSearch(`${option.name} ${tokenFor(option)} ${option.description}`).includes(normalizedQuery));
  }, [options, query]);

  const orderedOptions = useMemo(
    () => groupOrder.flatMap((group) => filteredOptions.filter((option) => option.group === group)),
    [filteredOptions],
  );

  const groups = useMemo(() => groupOrder.map((group) => ({
    group,
    options: orderedOptions.filter((option) => option.group === group),
  })).filter(({ group, options: groupOptions }) =>
    groupOptions.length > 0 || (group === "channel" && createVariableHref !== undefined),
  ), [createVariableHref, orderedOptions]);

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
      const option = orderedOptions[activeIndex];
      if (option !== undefined) {
        event.preventDefault();
        choose(option);
      }
    }
  };

  const renderContent = (surface: "popover" | "sheet"): ReactElement => {
    const surfacePanelId = surface === "sheet" ? sheetPanelId : popoverPanelId;
    const searchId = `${surfacePanelId}-search`;
    const listId = `${surfacePanelId}-list`;
    const activeOptionId = activeIndex < orderedOptions.length ? `${listId}-${String(activeIndex)}` : undefined;
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
          <div className="ui-variable-picker__group" role="group" aria-label={messages.groupLabels[group]} key={group}>
            {groupOptions.length > 0 ? <h3 className="ui-variable-picker__group-title">{messages.groupLabels[group]}</h3> : null}
            {orderedOptions.map((option, index) => option.group !== group ? null : (
              <button
                type="button"
                id={`${listId}-${String(index)}`}
                key={`${option.group}-${option.name}`}
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
                  <span className="ui-variable-picker__token">{tokenFor(option)}</span>
                  <span className="ui-variable-picker__description">{option.description}</span>
                </span>
                <span className="ui-variable-picker__sample">→ {option.sample}</span>
                {option.external === true ? (
                  <span className="ui-variable-picker__external" role="img" title={messages.externalHelp} aria-label={messages.externalHelp}>
                    <Icon name="external" size={16} />
                  </span>
                ) : null}
              </button>
            ))}
            {group === "channel" && createVariableHref !== undefined ? (
              <a className="ui-variable-picker__create" href={createVariableHref}>{messages.createVariableLabel}</a>
            ) : null}
          </div>
        ))}
        {orderedOptions.length === 0 && createVariableHref === undefined ? (
          <p className="ui-variable-picker__empty">{messages.noResults}</p>
        ) : null}
      </div>
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
        size="70vh"
        withCloseButton={false}
        classNames={{ content: "ui-variable-picker__drawer-content", body: "ui-variable-picker__drawer-body" }}
        aria-label={messages.title}
      >
        {renderContent("sheet")}
      </Drawer>
    </>
  );
}
