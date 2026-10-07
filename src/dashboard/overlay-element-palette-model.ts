import { MODULE_NAVIGATION_CATEGORIES, type ModuleNavigationCategory } from "../modules/contract";

export type OverlayElementPaletteGroupId = "variables" | ModuleNavigationCategory;

export interface OverlayElementPaletteItem {
  id: string;
  groupId: OverlayElementPaletteGroupId;
  label: string;
  description: string;
  moduleName?: string;
  variableName?: string;
  currentValue?: string;
  disabledReason?: string;
}

export interface OverlayElementPaletteGroup {
  id: OverlayElementPaletteGroupId;
  label: string;
  items: readonly OverlayElementPaletteItem[];
}

const normalizeSearch = (value: string): string => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/gu, "")
  .toLocaleLowerCase();

export const overlayElementPaletteItemMatchesQuery = (item: OverlayElementPaletteItem, rawQuery: string): boolean => {
  const query = normalizeSearch(rawQuery.trim());
  if (query.length === 0) return true;
  const searchableText = normalizeSearch([item.label, item.description, item.moduleName ?? "", item.variableName ?? ""].join(" "));
  return query.split(/\s+/u).every((term) => searchableText.includes(term));
};

/** Filters and orders palette items using the same category order as the module sidebar. */
export const groupOverlayElementPaletteItems = (
  items: readonly OverlayElementPaletteItem[],
  categoryLabels: Readonly<Record<ModuleNavigationCategory, string>>,
  variablesLabel: string,
  rawQuery = "",
): OverlayElementPaletteGroup[] => {
  const query = normalizeSearch(rawQuery.trim());
  const groups = new Map<OverlayElementPaletteGroupId, OverlayElementPaletteItem[]>();
  for (const item of items) {
    if (query.length > 0 && !overlayElementPaletteItemMatchesQuery(item, query)) continue;
    const group = groups.get(item.groupId);
    if (group === undefined) groups.set(item.groupId, [item]);
    else group.push(item);
  }

  const order = new Map<OverlayElementPaletteGroupId, number>([
    ["variables", 0],
    ...MODULE_NAVIGATION_CATEGORIES.map((category, index) => [category, index + 1] as const),
  ]);
  return [...groups.entries()]
    .sort(([left], [right]) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER))
    .map(([id, groupItems]) => ({
      id,
      label: id === "variables" ? variablesLabel : categoryLabels[id],
      items: [...groupItems].sort((left, right) => Number(left.disabledReason !== undefined) - Number(right.disabledReason !== undefined)),
    }));
};
