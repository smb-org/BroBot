import { Drawer, Popover, TextInput } from "@mantine/core";
import { cloneElement, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";

import { Button } from "./Button";
import { Icon } from "./Icon";

import "./GroupedPicker.css";

export interface GroupedPickerEntry<T = unknown> {
  /** Stable identity within its group. */
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  /** Additional searchable terms, such as a module or canonical variable name. */
  searchText?: string;
  /** Optional caller-owned value returned to `onSelect`. */
  value?: T;
}

export interface GroupedPickerGroup<T = unknown> {
  id: string;
  label: string;
  icon?: ReactNode;
  entries: readonly GroupedPickerEntry<T>[];
  footer?: ReactNode;
}

export interface GroupedPickerMessages {
  title: string;
  searchLabel: string;
  closeLabel: string;
  noResults: string | ((query: string) => string);
  keyHints: { navigate: string; choose: string; close: string };
}

export interface GroupedPickerProps<T = unknown> {
  groups: readonly GroupedPickerGroup<T>[];
  messages: GroupedPickerMessages;
  trigger: ReactElement;
  onSelect: (entry: GroupedPickerEntry<T>) => void;
  opened?: boolean;
  defaultOpened?: boolean;
  onOpenedChange?: (opened: boolean) => void;
  disabled?: boolean;
  /** Focus target after selecting or dismissing with Escape. Defaults to the trigger. */
  onDismissFocus?: () => void;
  /** Override the standard label/description content while retaining picker behavior. */
  renderEntryContent?: (entry: GroupedPickerEntry<T>, active: boolean) => ReactNode;
  /** Override the default normalized label/description/searchText matcher. */
  filterEntry?: (entry: GroupedPickerEntry<T>, query: string) => boolean;
  /** Reorder matched groups or entries, for example by search relevance. */
  transformGroups?: (groups: readonly GroupedPickerGroup<T>[], query: string) => readonly GroupedPickerGroup<T>[];
  showNoResults?: boolean;
  footer?: ReactNode;
  /** When supplied, the active entry's detail renders in one fixed-height slot above the key hints, so rows keep a constant height. */
  renderActiveDetail?: (entry: GroupedPickerEntry<T>) => ReactNode;
  width?: number | string;
}

interface IndexedEntry<T> {
  entry: GroupedPickerEntry<T>;
  groupId: string;
  key: string;
  optionId: string;
}

interface InteractiveTriggerProps {
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "dialog";
  "aria-controls"?: string;
}

const normalizeSearch = (value: string): string => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/gu, "")
  .toLowerCase();

const defaultMatches = (entry: GroupedPickerEntry, query: string): boolean => {
  const normalizedQuery = normalizeSearch(query.trim());
  if (normalizedQuery.length === 0) return true;
  return [entry.label, entry.description ?? "", entry.searchText ?? ""]
    .some((value) => normalizeSearch(value).includes(normalizedQuery));
};

const toIdPart = (value: string): string => encodeURIComponent(value);

export function GroupedPicker<T = unknown>({
  groups,
  messages,
  trigger,
  onSelect,
  opened: suppliedOpened,
  defaultOpened = false,
  onOpenedChange,
  disabled = false,
  onDismissFocus,
  renderEntryContent,
  filterEntry,
  transformGroups,
  showNoResults = true,
  footer,
  renderActiveDetail,
  width = 400,
}: GroupedPickerProps<T>): ReactElement {
  const generatedId = useId();
  const panelId = `grouped-picker-${generatedId}`;
  const popoverPanelId = `${panelId}-popover`;
  const sheetPanelId = `${panelId}-sheet`;
  const triggerRef = useRef<HTMLSpanElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [internalOpened, setInternalOpened] = useState(defaultOpened);
  const opened = suppliedOpened ?? internalOpened;
  const [isSmallScreen, setIsSmallScreen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 599px)");
    const update = (): void => setIsSmallScreen(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const filteredGroups = useMemo(() => groups
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) => (filterEntry ?? defaultMatches)(entry, query)),
    }))
    .filter((group) => group.entries.length > 0 || group.footer !== undefined), [filterEntry, groups, query]);
  const visibleGroups = useMemo(() => transformGroups?.(filteredGroups, query) ?? filteredGroups, [filteredGroups, query, transformGroups]);

  const panel = isSmallScreen ? sheetPanelId : popoverPanelId;
  const listId = `${panel}-list`;
  const indexedGroups: readonly { group: GroupedPickerGroup<T>; entries: readonly IndexedEntry<T>[] }[] = visibleGroups.map((group) => ({
    group,
    entries: group.entries.map((entry) => {
      const key = `${group.id}\u0000${entry.id}`;
      return { entry, groupId: group.id, key, optionId: `${listId}-${toIdPart(group.id)}-${toIdPart(entry.id)}` };
    }),
  }));
  const entries = indexedGroups.flatMap(({ entries: groupEntries }) => groupEntries);
  const navigableEntries = entries.filter(({ entry }) => entry.disabled !== true);
  const activeEntry = navigableEntries.find(({ key }) => key === activeKey) ?? navigableEntries[0];
  const activeEntryKey = activeEntry?.key;
  const focusTrigger = (): void => {
    const target = triggerRef.current?.querySelector<HTMLElement>("button, [href], input, [tabindex]:not([tabindex='-1'])");
    target?.focus();
  };

  const restoreFocus = (): void => {
    window.requestAnimationFrame(() => {
      if (onDismissFocus !== undefined) onDismissFocus();
      else focusTrigger();
    });
  };

  const changeOpened = (nextOpened: boolean): void => {
    if (nextOpened !== opened) {
      setQuery("");
      setActiveKey(null);
    }
    if (suppliedOpened === undefined) setInternalOpened(nextOpened);
    onOpenedChange?.(nextOpened);
  };

  const handleOpenedChange = (nextOpened: boolean): void => {
    if (!disabled || !nextOpened) changeOpened(nextOpened);
  };

  const triggerProps = trigger.props as { disabled?: boolean; onClick?: (event: MouseEvent<HTMLElement>) => void };
  const interactiveTrigger = cloneElement(
    trigger as ReactElement<InteractiveTriggerProps>,
    {
      disabled: disabled || triggerProps.disabled === true,
      "aria-expanded": opened,
      "aria-haspopup": "dialog",
      "aria-controls": isSmallScreen ? sheetPanelId : popoverPanelId,
      onClick: (event) => {
        triggerProps.onClick?.(event);
        if (!disabled && triggerProps.disabled !== true) changeOpened(!opened);
      },
    },
  );

  useEffect(() => {
    if (!opened) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [opened, isSmallScreen]);

  useEffect(() => {
    if (activeEntryKey === undefined) return;
    optionRefs.current.get(activeEntryKey)?.scrollIntoView({ block: "nearest" });
  }, [activeEntryKey]);

  const close = (restore: boolean): void => {
    changeOpened(false);
    if (restore) restoreFocus();
  };

  const choose = (entry: GroupedPickerEntry<T>): void => {
    if (entry.disabled === true) return;
    onSelect(entry);
    close(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (navigableEntries.length === 0) return;
    const currentIndex = navigableEntries.findIndex(({ key }) => key === activeEntry?.key);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveKey(navigableEntries[(currentIndex + 1) % navigableEntries.length]?.key ?? null);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = currentIndex < 0 ? navigableEntries.length - 1 : (currentIndex - 1 + navigableEntries.length) % navigableEntries.length;
      setActiveKey(navigableEntries[nextIndex]?.key ?? null);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveKey(navigableEntries[0]?.key ?? null);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveKey(navigableEntries.at(-1)?.key ?? null);
    } else if (event.key === "Enter" && activeEntry !== undefined) {
      event.preventDefault();
      choose(activeEntry.entry);
    }
  };

  const renderContent = (surface: "popover" | "sheet"): ReactElement => {
    const surfacePanelId = surface === "sheet" ? sheetPanelId : popoverPanelId;
    const surfaceListId = `${surfacePanelId}-list`;
    const activeOptionId = activeEntry?.optionId;
    const noResults = typeof messages.noResults === "function" ? messages.noResults(query) : messages.noResults;

    return (
      <div id={surfacePanelId} className={`ui-grouped-picker${surface === "sheet" ? " ui-grouped-picker--sheet" : ""}`}>
        {surface === "sheet" ? (
          <div className="ui-grouped-picker__mobile-header">
            <span className="ui-grouped-picker__handle" aria-hidden="true" />
            <Drawer.Title component="h2">{messages.title}</Drawer.Title>
            <Button icon="close" iconOnly ariaLabel={messages.closeLabel} variant="subtle" onClick={() => close(true)} />
          </div>
        ) : null}
        <TextInput
          ref={searchRef}
          data-autofocus
          id={`${surfacePanelId}-search`}
          className="ui-grouped-picker__search"
          aria-label={messages.searchLabel}
          placeholder={messages.searchLabel}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={surfaceListId}
          aria-activedescendant={activeOptionId}
          aria-describedby={renderActiveDetail === undefined ? undefined : `${surfacePanelId}-detail`}
          leftSection={<Icon name="search" size={16} />}
          value={query}
          onChange={(event) => { setQuery(event.currentTarget.value); setActiveKey(null); }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />
        <div id={surfaceListId} className="ui-grouped-picker__list" role="listbox" aria-label={messages.title}>
          {indexedGroups.map(({ group, entries: groupEntries }) => (
            <div className="ui-grouped-picker__group" role="group" aria-label={group.label} key={group.id}>
              <h3 className="ui-grouped-picker__group-heading">
                <span className="ui-grouped-picker__group-title">
                  {group.icon === undefined ? null : <span className="ui-grouped-picker__group-icon" aria-hidden="true">{group.icon}</span>}
                  <span>{group.label}</span>
                </span>
              </h3>
              {groupEntries.map(({ entry, key, optionId }) => {
                const active = activeEntry?.key === key;
                return (
                  <button
                    type="button"
                    id={optionId}
                    key={key}
                    ref={(element) => {
                      if (element === null) optionRefs.current.delete(key);
                      else optionRefs.current.set(key, element);
                    }}
                    className="ui-grouped-picker__option"
                    role="option"
                    aria-selected={active}
                    aria-disabled={entry.disabled === true || undefined}
                    disabled={entry.disabled === true}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => { if (entry.disabled !== true) setActiveKey(key); }}
                    onClick={() => choose(entry)}
                  >
                    {entry.icon === null || entry.icon === undefined ? null : <span className="ui-grouped-picker__entry-icon" aria-hidden="true">{entry.icon}</span>}
                    {renderEntryContent === undefined ? (
                      <span className="ui-grouped-picker__option-copy">
                        <span className="ui-grouped-picker__label">{entry.label}</span>
                        {entry.description === undefined ? null : <span className="ui-grouped-picker__description">{entry.description}</span>}
                      </span>
                    ) : renderEntryContent(entry, active)}
                    {entry.trailing === undefined && entry.disabledReason === undefined ? null : (
                      <span className="ui-grouped-picker__trailing">
                        {entry.trailing}
                        {entry.disabledReason === undefined ? null : <span className="ui-grouped-picker__disabled-reason">{entry.disabledReason}</span>}
                      </span>
                    )}
                  </button>
                );
              })}
              {group.footer === undefined ? null : <div className="ui-grouped-picker__group-footer">{group.footer}</div>}
            </div>
          ))}
          {entries.length === 0 && showNoResults ? <p className="ui-grouped-picker__empty" role="status">{noResults}</p> : null}
        </div>
        {footer === undefined ? null : <div className="ui-grouped-picker__footer">{footer}</div>}
        {renderActiveDetail === undefined ? null : (
          <div id={`${surfacePanelId}-detail`} className="ui-grouped-picker__detail" aria-live="polite">
            {activeEntry === undefined ? null : renderActiveDetail(activeEntry.entry)}
          </div>
        )}
        <div className="ui-grouped-picker__key-hints">
          <span className="ui-grouped-picker__key-hint"><kbd>↑↓</kbd>{messages.keyHints.navigate}</span>
          <span className="ui-grouped-picker__key-hint"><kbd>Enter</kbd>{messages.keyHints.choose}</span>
          <span className="ui-grouped-picker__key-hint"><kbd>Esc</kbd>{messages.keyHints.close}</span>
        </div>
      </div>
    );
  };

  return (
    <>
      <span className="ui-grouped-picker__trigger" ref={triggerRef}>
        <Popover
          opened={opened && !isSmallScreen}
          onChange={handleOpenedChange}
          withinPortal
          position="bottom-end"
          width={width}
          closeOnEscape={false}
          trapFocus
          closeOnClickOutside
        >
          <Popover.Target>{interactiveTrigger}</Popover.Target>
          <Popover.Dropdown
            role="dialog"
            aria-label={messages.title}
            className="ui-grouped-picker__popover"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              close(true);
            }}
          >
            {renderContent("popover")}
          </Popover.Dropdown>
        </Popover>
      </span>
      <Drawer
        opened={opened && isSmallScreen}
        onClose={() => close(true)}
        position="bottom"
        withCloseButton={false}
        overlayProps={{ backgroundOpacity: 0.35, blur: 1 }}
        classNames={{ content: "ui-grouped-picker__drawer-content", body: "ui-grouped-picker__drawer-body" }}
        withinPortal
      >
        {renderContent("sheet")}
      </Drawer>
    </>
  );
}
