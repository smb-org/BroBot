import type { TemplateVariableGroup } from "../../contracts/values";
import type { IconName } from "./Icon";

type TemplateTextFieldGroupKey = "module" | "channel" | "own" | "text_blocks";
type TemplateTextFieldOptionKind = "system" | "module" | "channel";

export interface TemplateTextFieldGroupPresentation {
  id: string;
  label: string;
  iconPaths?: readonly string[];
  iconName?: IconName;
  order: number;
}

export interface TemplateTextFieldOption {
  /** Canonical variable name, without braces. */
  name: string;
  /** Localized short label shown above the token. */
  label?: string;
  /** Short description in the active dashboard language. */
  description: string;
  /** Example or current channel value in the active dashboard language. */
  sample: string;
  group?: TemplateVariableGroup;
  kind?: TemplateTextFieldOptionKind;
  sourceGroup?: TemplateTextFieldGroupPresentation;
  isTextBlock?: boolean;
  /** Helix-backed variables make a Twitch request when the command runs. */
  external?: boolean;
  /** Default parameter text to select after inserting a parameterized token. */
  parameter?: { value: string };
}

export interface TemplateTextFieldPickerMessages {
  title: string;
  noResults: string;
  externalHelp: string;
  groupLabels: Readonly<Record<TemplateTextFieldGroupKey, string>>;
  keyHints: { navigate: string; insert: string; close: string };
}

export interface GroupedTemplateTextFieldOptions {
  group: TemplateTextFieldGroupPresentation;
  options: readonly { option: TemplateTextFieldOption; index: number }[];
}

const hostGroupOrder: Readonly<Record<TemplateTextFieldGroupKey, number>> = {
  module: 10,
  channel: 20,
  own: 30,
  text_blocks: 40,
};

const hostGroupIcons: Readonly<Record<TemplateTextFieldGroupKey, IconName>> = {
  module: "tabSettings",
  channel: "broadcast",
  own: "variable",
  text_blocks: "tabCode",
};

const normalizeSearch = (value: string): string => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/gu, "")
  .toLowerCase();

const uniqueTemplateTextFieldOptions = (options: readonly TemplateTextFieldOption[]): TemplateTextFieldOption[] => {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.name)) return false;
    seen.add(option.name);
    return true;
  });
};

export const filterTemplateTextFieldOptions = (
  options: readonly TemplateTextFieldOption[],
  query: string,
): TemplateTextFieldOption[] => {
  const normalizedQuery = normalizeSearch(query.trim());
  const uniqueOptions = uniqueTemplateTextFieldOptions(options);
  if (normalizedQuery.length === 0) return uniqueOptions;
  return uniqueOptions
    .map((option, index) => {
      const name = normalizeSearch(option.name);
      const label = normalizeSearch(option.label ?? option.name);
      const description = normalizeSearch(option.description);
      const groupLabel = normalizeSearch(option.sourceGroup?.label ?? "");
      const nameOrLabel = [name, label];
      const isNameOrLabelPrefix = nameOrLabel.some((value) => value.startsWith(normalizedQuery));
      const matchesNameOrLabel = nameOrLabel.some((value) => value.includes(normalizedQuery));
      const rank = isNameOrLabelPrefix
        ? 0
        : matchesNameOrLabel
          ? 1
          : description.includes(normalizedQuery)
            ? 2
            : groupLabel.includes(normalizedQuery) ? 3 : -1;
      return { option, index, rank };
    })
    .filter(({ rank }) => rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ option }) => option);
};

const resolveTemplateTextFieldGroup = (
  option: TemplateTextFieldOption,
  messages: Pick<TemplateTextFieldPickerMessages, "groupLabels">,
): TemplateTextFieldGroupPresentation => {
  const group: TemplateTextFieldGroupKey = option.isTextBlock
    ? "text_blocks"
    : option.kind === "channel" ? "own" : option.kind === "system" ? "channel" : "module";
  return {
    id: group,
    label: messages.groupLabels[group],
    iconName: hostGroupIcons[group],
    order: hostGroupOrder[group],
  };
};

export const groupTemplateTextFieldOptions = (
  options: readonly TemplateTextFieldOption[],
  messages: Pick<TemplateTextFieldPickerMessages, "groupLabels">,
): GroupedTemplateTextFieldOptions[] => {
  const grouped = new Map<string, { group: TemplateTextFieldGroupPresentation; options: { option: TemplateTextFieldOption; index: number }[] }>();
  const uniqueOptions = uniqueTemplateTextFieldOptions(options);
  uniqueOptions.forEach((option, index) => {
    const group = resolveTemplateTextFieldGroup(option, messages);
    if (option.sourceGroup?.iconPaths !== undefined && group.id === "module") {
      group.iconPaths = option.sourceGroup.iconPaths;
    }
    const existing = grouped.get(group.id);
    if (existing === undefined) grouped.set(group.id, { group, options: [{ option, index }] });
    else existing.options.push({ option, index });
  });
  return [...grouped.values()].sort((left, right) => left.group.order - right.group.order);
};

export const reindexGroupedTemplateTextFieldOptions = (
  groups: readonly GroupedTemplateTextFieldOptions[],
): GroupedTemplateTextFieldOptions[] => {
  let index = 0;
  return groups.map(({ group, options }) => ({
    group,
    options: options.map(({ option }) => ({ option, index: index++ })),
  }));
};

export const prioritizeTemplateTextFieldNamespace = (
  groups: readonly GroupedTemplateTextFieldOptions[],
  query: string,
): GroupedTemplateTextFieldOptions[] => {
  const namespace = /^([A-Za-z][A-Za-z0-9_]*)\./u.exec(query.trim())?.[1]?.toLowerCase();
  if (namespace === undefined) return [...groups];
  const targetGroup = namespace === "var" ? "own" : namespace === "text" ? "text_blocks" : "module";
  const matchingIndex = groups.findIndex(({ group }) => group.id.toLowerCase() === targetGroup);
  if (matchingIndex <= 0) return [...groups];
  const result = [...groups];
  const [activeGroup] = result.splice(matchingIndex, 1);
  if (activeGroup !== undefined) result.unshift(activeGroup);
  return result;
};
