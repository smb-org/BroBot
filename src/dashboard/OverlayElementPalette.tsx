import type { ReactElement, ReactNode } from "react";

import {
  groupOverlayElementPaletteItems,
  overlayElementPaletteItemMatchesQuery,
  type OverlayElementPaletteItem,
} from "./overlay-element-palette-model";
import { GroupedPicker, type GroupedPickerEntry, type GroupedPickerMessages } from "./ui";
import "./overlay-element-palette.css";

export interface OverlayElementPaletteOption extends OverlayElementPaletteItem {
  icon: ReactNode;
}

export interface OverlayElementPaletteMessages extends GroupedPickerMessages {
  variablesLabel: string;
  categoryLabels: Parameters<typeof groupOverlayElementPaletteItems>[1];
  limitMessage?: string;
}

export interface OverlayElementPaletteProperties {
  options: readonly OverlayElementPaletteOption[];
  messages: OverlayElementPaletteMessages;
  trigger: ReactElement;
  disabled?: boolean;
  disableEntries?: boolean;
  onSelect: (option: OverlayElementPaletteOption) => void;
}

export function OverlayElementPalette({ options, messages, trigger, disabled = false, disableEntries = false, onSelect }: OverlayElementPaletteProperties): ReactElement {
  const groupedItems = groupOverlayElementPaletteItems(options, messages.categoryLabels, messages.variablesLabel);
  const optionsById = new Map(options.map((option) => [option.id, option]));
  const groups = groupedItems.map((group) => ({
    id: group.id,
    label: group.label,
    entries: group.items.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      icon: optionsById.get(item.id)?.icon ?? null,
      trailing: item.currentValue === undefined ? undefined : <span className="overlay-element-palette__value" title={item.currentValue}>{item.currentValue}</span>,
      disabled: item.disabledReason !== undefined || disableEntries,
      ...(item.disabledReason === undefined ? {} : { disabledReason: item.disabledReason }),
      searchText: [item.moduleName, item.variableName].filter((value): value is string => value !== undefined).join(" "),
    })),
  }));

  const optionMatches = (entry: GroupedPickerEntry, query: string): boolean => {
    const option = optionsById.get(entry.id);
    return option !== undefined && overlayElementPaletteItemMatchesQuery(option, query);
  };
  const selectOption = (entry: GroupedPickerEntry): void => {
    const option = optionsById.get(entry.id);
    if (option !== undefined && option.disabledReason === undefined && !disableEntries) onSelect(option);
  };

  return (
    <GroupedPicker
      groups={groups}
      messages={messages}
      trigger={trigger}
      disabled={disabled}
      filterEntry={optionMatches}
      onSelect={selectOption}
      footer={messages.limitMessage === undefined ? undefined : <p className="overlay-element-palette__limit" role="note">{messages.limitMessage}</p>}
    />
  );
}
