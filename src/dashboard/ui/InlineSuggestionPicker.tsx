import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cloneElement, createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefCallback } from "react";

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

const PickerTargetContext = createContext<RefCallback<HTMLElement> | null>(null);

interface InlineSuggestionPickerControls {
  activeIndex: number;
  activeOptionId: string | undefined;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  close: () => void;
}

export function InlineSuggestionPickerTarget({ children }: { children: ReactElement }): ReactElement {
  const targetRef = useContext(PickerTargetContext);
  const child = children as ReactElement<{ ref?: RefCallback<HTMLElement> }>;
  const childRef = child.props.ref;
  const mergedRef = useCallback((element: HTMLElement | null): void => {
    targetRef?.(element);
    childRef?.(element);
  }, [childRef, targetRef]);

  return targetRef === null ? children : cloneElement(child, { ref: mergedRef });
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
  const anchorRef = useRef<HTMLElement>(null);
  const targetRef = useCallback((element: HTMLElement | null): void => {
    anchorRef.current = element;
  }, []);

  const close = (): void => {
    onClose();
    setActiveSelection({ groupKey, index: 0 });
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
    if (!open) return;
    scrollOptionIntoView(activeOptionId);
  }, [activeOptionId, open]);

  const controls: InlineSuggestionPickerControls = { activeIndex, activeOptionId, handleKeyDown, close };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <PickerTargetContext.Provider value={targetRef}>
        {children(controls)}
      </PickerTargetContext.Provider>
      {open ? <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchorRef} side="bottom" align="start" sideOffset={4} collisionPadding={12} collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "start" }} className="z-[var(--layer-popover)]" style={{ zIndex: "var(--layer-popover)" }}>
          <PopoverPrimitive.Popup data-ui="" className="ui-template-text-field__suggestions-dropdown" initialFocus={false} finalFocus={false}>
            <div id={listboxId} className="ui-template-text-field__suggestions" role="listbox" aria-label={messages.title}>
              {groups.map(({ group, options: groupOptions }) => (
                <div className="ui-template-text-field__suggestions-group" role="group" aria-label={group.label} key={group.id}>
                  <div className="ui-template-text-field__group-label"><GroupHeading group={group} /></div>
                  {groupOptions.map(({ option, index }) => (
                    <div
                      id={`${listboxId}-${option.name}`}
                      key={option.name}
                      role="option"
                      aria-selected={index === activeIndex}
                      className="ui-template-text-field__suggestion"
                      onMouseDown={(event) => { event.preventDefault(); }}
                      onClick={() => { onSelect(option.name); }}
                    >{renderOption(option, index === activeIndex)}</div>
                  ))}
                </div>
              ))}
              {options.length === 0 ? <div className="ui-template-text-field__no-results">{messages.noResults}</div> : null}
            </div>
            <KeyboardHints messages={messages} />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal> : null}
    </PopoverPrimitive.Root>
  );
}
