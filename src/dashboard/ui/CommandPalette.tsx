import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Command } from "cmdk";

import { Icon, type IconName } from "./Icon";

export interface CommandPaletteItem {
  id: string;
  label: string;
  recentTargetPath?: string;
  description?: string;
  group?: string;
  category?: string;
  categoryLabel?: string;
  keywords?: readonly string[];
  icon?: IconName | Exclude<ReactNode, string>;
  disabled?: boolean;
  disabledReason?: string;
  onTrigger: () => void;
}

export interface CommandPaletteProps {
  items: readonly CommandPaletteItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  emptyMessage: string;
  title: string;
  description: string;
  placeholder: string;
  navigateHint: string;
  openHint: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  onOpen?: () => void;
}

const fold = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase();

const matchesQuery = (item: CommandPaletteItem, query: string): boolean => {
  const normalizedQuery = fold(query.trim());
  if (normalizedQuery.length === 0) return true;
  const searchableText = fold([item.label, item.description ?? "", item.group ?? "", ...(item.keywords ?? [])].join(" "));
  if (searchableText.includes(normalizedQuery)) return true;
  return (item.keywords ?? []).some((keyword) => {
    const normalizedKeyword = fold(keyword.trim());
    return normalizedKeyword.length > 0 && (normalizedQuery.startsWith(normalizedKeyword) || normalizedKeyword.startsWith(normalizedQuery));
  });
};

export function CommandPalette({
  items,
  open,
  onOpenChange,
  emptyMessage,
  title,
  description,
  placeholder,
  navigateHint,
  openHint,
  query,
  onQueryChange,
  onOpen,
}: CommandPaletteProps) {
  const [uncontrolledQuery, setUncontrolledQuery] = useState("");
  const wasOpen = useRef(false);
  const currentQuery = query ?? uncontrolledQuery;
  const groupedItems = useMemo(() => {
    const groups = new Map<string, CommandPaletteItem[]>();
    for (const item of items) {
      if (!matchesQuery(item, currentQuery)) continue;
      const heading = item.group ?? "";
      const group = groups.get(heading);
      if (group === undefined) groups.set(heading, [item]);
      else group.push(item);
    }
    return [...groups.entries()];
  }, [currentQuery, items]);

  useEffect(() => {
    if (open && !wasOpen.current) onOpen?.();
    wasOpen.current = open;
  }, [onOpen, open]);

  const changeQuery = (value: string): void => {
    if (query === undefined) setUncontrolledQuery(value);
    onQueryChange?.(value);
  };

  return (
    <Command.Dialog
      aria-describedby="command-palette-description"
      aria-label={title}
      contentClassName="command-palette"
      label={title}
      onOpenChange={onOpenChange}
      open={open}
      shouldFilter={false}
    >
      <div className="command-palette__dialog" data-ui="">
        <p className="sr-only" id="command-palette-description">{description}</p>
        <div className="command-palette__search">
          <Icon name="search" size={20} />
          <Command.Input autoFocus onValueChange={changeQuery} placeholder={placeholder} value={currentQuery} />
          <kbd>Esc</kbd>
        </div>
        <Command.List className="command-palette__list">
          {groupedItems.length === 0 ? <Command.Empty>{emptyMessage}</Command.Empty> : null}
          {groupedItems.map(([heading, groupItems]) => (
            <Command.Group heading={heading || undefined} key={heading || "default"}>
              {groupItems.map((item) => {
                const descriptionText = item.disabled ? item.disabledReason ?? item.description : item.description;
                const itemIcon = typeof item.icon === "string"
                  ? <Icon name={item.icon as IconName} size={20} />
                  : item.icon;
                return (
                  <Command.Item
                    {...(item.category === undefined ? {} : { "data-category": item.category })}
                    data-command-palette-item-id={item.id}
                    {...(item.disabled === undefined ? {} : { disabled: item.disabled })}
                    key={item.id}
                    onSelect={() => {
                      if (item.disabled) return;
                      item.onTrigger();
                      onOpenChange(false);
                    }}
                    value={`${item.label} ${item.description ?? ""} ${item.group ?? ""} ${(item.keywords ?? []).join(" ")}`}
                  >
                    {itemIcon === undefined ? null : <span className="command-palette__item-icon">{itemIcon}</span>}
                    <span className="command-palette__item-copy">
                      <span className="command-palette__item-main">{item.label}</span>
                      {descriptionText === undefined ? null : <span className="command-palette__item-description">{descriptionText}</span>}
                    </span>
                    {item.category === undefined ? null : <span aria-hidden="true" className={`command-palette__category command-palette__category--${item.category}`}>{item.categoryLabel ?? item.category}</span>}
                    <span aria-hidden="true" className="command-palette__arrow">↵</span>
                  </Command.Item>
                );
              })}
            </Command.Group>
          ))}
        </Command.List>
        <div className="command-palette__footer"><span>↑ ↓ {navigateHint}</span><span><kbd>Enter</kbd> {openHint}</span></div>
      </div>
    </Command.Dialog>
  );
}
