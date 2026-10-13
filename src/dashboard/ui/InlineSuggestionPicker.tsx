import { Combobox, useCombobox } from "@mantine/core";
import { useEffect, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export interface InlineSuggestionGroupPresentation {
  id: string;
  label: string;
  iconPaths?: readonly string[];
  iconName?: IconName;
  order: number;
}

export interface InlineSuggestionGroup<Option extends { name: string }> {
  group: InlineSuggestionGroupPresentation;
  options: readonly { option: Option; index: number }[];
}

export interface InlineSuggestionPickerMessages {
  title: string;
  noResults: string;
  keyHints: { navigate: string; insert: string; close: string };
}

interface InlineSuggestionPickerControls {
  activeIndex: number;
  activeOptionId: string | undefined;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  close: () => void;
}

export function InlineSuggestionPickerTarget({ children }: { children: ReactElement }): ReactElement {
  return <Combobox.Target withKeyboardNavigation={false} withAriaAttributes={false}>{children}</Combobox.Target>;
}

interface InlineSuggestionPickerProps<Option extends { name: string }> {
  listboxId: string;
  open: boolean;
  groups: readonly InlineSuggestionGroup<Option>[];
  messages: InlineSuggestionPickerMessages;
  onSelect: (name: string) => void;
  onClose: () => void;
  renderOption: (option: Option, active: boolean) => ReactNode;
  children: (controls: InlineSuggestionPickerControls) => ReactNode;
}

const GroupHeading = ({ group }: { group: InlineSuggestionGroupPresentation }): ReactElement => (
  <span className="ui-template-text-field__group-title">
    {group.iconPaths === undefined
      ? <Icon name={group.iconName ?? "variable"} size={16} />
      : <svg className="ui-template-text-field__group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {group.iconPaths.map((path, index) => <path key={`${group.id}-${String(index)}`} d={path} />)}
      </svg>}
    <span>{group.label}</span>
  </span>
);

const KeyboardHints = ({ messages }: { messages: InlineSuggestionPickerMessages }): ReactElement => (
  <div className="ui-template-text-field__key-hints">
    <span><kbd>↑↓</kbd>{messages.keyHints.navigate}</span>
    <span><kbd>Enter</kbd>{messages.keyHints.insert}</span>
    <span><kbd>Esc</kbd>{messages.keyHints.close}</span>
  </div>
);

const scrollOptionIntoView = (id: string | undefined): void => {
  if (id === undefined) return;
  const option = document.getElementById(id);
  if (option === null) return;
  const scrollIntoView = Reflect.get(option, "scrollIntoView");
  if (typeof scrollIntoView === "function") Reflect.apply(scrollIntoView, option, [{ block: "nearest" }]);
};

export function InlineSuggestionPicker<Option extends { name: string }>({
  listboxId,
  open,
  groups,
  messages,
  onSelect,
  onClose,
  renderOption,
  children,
}: InlineSuggestionPickerProps<Option>): ReactElement {
  const groupKey = groups.map(({ group, options: groupOptions }) => `${group.id}:${groupOptions.map(({ option }) => option.name).join(",")}`).join("|");
  const [activeSelection, setActiveSelection] = useState<{ groupKey: string; index: number }>({ groupKey, index: 0 });
  const activeIndex = activeSelection.groupKey === groupKey ? activeSelection.index : 0;
  const options = groups.flatMap(({ options: groupOptions }) => groupOptions);
  const activeOption = options[activeIndex]?.option ?? options[0]?.option;
  const activeOptionId = activeOption === undefined ? undefined : `${listboxId}-${activeOption.name}`;
  const combobox = useCombobox();

  const close = (): void => {
    onClose();
    setActiveSelection({ groupKey, index: 0 });
    combobox.closeDropdown();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return true;
    }
    if (event.key === "ArrowDown" && options.length > 0) {
      event.preventDefault();
      setActiveSelection({ groupKey, index: (activeIndex + 1) % options.length });
      return true;
    }
    if (event.key === "ArrowUp" && options.length > 0) {
      event.preventDefault();
      setActiveSelection({ groupKey, index: (activeIndex - 1 + options.length) % options.length });
      return true;
    }
    if (event.key === "Enter" && activeOption !== undefined) {
      event.preventDefault();
      onSelect(activeOption.name);
      close();
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (open) combobox.openDropdown();
    else combobox.closeDropdown();
  }, [combobox, open]);

  useEffect(() => {
    if (!open) return;
    scrollOptionIntoView(activeOptionId);
  }, [activeOptionId, open]);

  const controls: InlineSuggestionPickerControls = { activeIndex, activeOptionId, handleKeyDown, close };

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={onSelect}
      withinPortal
      position="bottom-start"
      hideDetached={false}
      preventPositionChangeWhenVisible={false}
      middlewares={{
        flip: true,
        shift: { padding: 12 },
        size: {
          padding: 12,
          apply: ({ availableHeight, elements }) => {
            elements.floating.style.maxHeight = `${String(Math.max(0, Math.min(440, availableHeight)))}px`;
          },
        },
      }}
      shadow="xs"
      width="min(400px, calc(100vw - 24px))"
    >
      {children(controls)}
      {open ? (
        <Combobox.Dropdown data-ui="" className="ui-template-text-field__suggestions-dropdown">
          <Combobox.Options id={listboxId} className="ui-template-text-field__suggestions" role="listbox" aria-label={messages.title}>
            {groups.map(({ group, options: groupOptions }) => (
              <Combobox.Group key={group.id} label={<GroupHeading group={group} />}>
                {groupOptions.map(({ option, index }) => (
                  <Combobox.Option
                    id={`${listboxId}-${option.name}`}
                    key={option.name}
                    value={option.name}
                    active={index === activeIndex}
                    className="ui-template-text-field__suggestion"
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => { event.preventDefault(); }}
                  >
                    {renderOption(option, index === activeIndex)}
                  </Combobox.Option>
                ))}
              </Combobox.Group>
            ))}
            {options.length === 0 ? <Combobox.Empty className="ui-template-text-field__no-results">{messages.noResults}</Combobox.Empty> : null}
          </Combobox.Options>
          <KeyboardHints messages={messages} />
        </Combobox.Dropdown>
      ) : null}
    </Combobox>
  );
}
