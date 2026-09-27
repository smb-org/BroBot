import type { TemplateVariableGroup } from "../../contracts/values";
import type { IconName } from "./Icon";

export type TemplateVariablePickerGroupKey = TemplateVariableGroup | "text_blocks";
export type TemplateVariablePickerGroup = TemplateVariableGroup;
export type TemplateVariablePickerKind = "system" | "module" | "channel";

export interface TemplateVariablePickerGroupPresentation {
  id: string;
  label: string;
  iconPaths?: readonly string[];
  iconName?: IconName;
  order: number;
}

export interface TemplateVariablePickerOption {
  /** Canonical variable name, without braces. */
  name: string;
  /** Localized short label shown above the token. */
  label?: string;
  /** Short description in the active dashboard language. */
  description: string;
  /** Example or current channel value in the active dashboard language. */
  sample: string;
  group?: TemplateVariableGroup;
  kind?: TemplateVariablePickerKind;
  pickerGroup?: TemplateVariablePickerGroupPresentation;
  isTextBlock?: boolean;
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
  groupLabels: Readonly<Record<TemplateVariablePickerGroupKey, string>>;
  textBlockSample: string;
  keyHints: { navigate: string; insert: string; close: string };
}

export interface GroupedTemplateVariableOptions {
  group: TemplateVariablePickerGroupPresentation;
  options: readonly { option: TemplateVariablePickerOption; index: number }[];
}

const hostGroupOrder: Readonly<Record<TemplateVariablePickerGroupKey, number>> = {
  context: 5,
  stream: 20,
  person: 30,
  command: 40,
  time_random: 50,
  event: 60,
  channel: 80,
  text_blocks: 90,
};

const hostGroupIcons: Readonly<Record<TemplateVariablePickerGroupKey, IconName>> = {
  context: "member",
  stream: "broadcast",
  person: "member",
  command: "variable",
  time_random: "clock-hour-4",
  event: "cause",
  channel: "variable",
  text_blocks: "tabCode",
};

const normalizeSearch = (value: string): string => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/gu, "")
  .toLowerCase();

export const filterTemplateVariableOptions = (
  options: readonly TemplateVariablePickerOption[],
  query: string,
): TemplateVariablePickerOption[] => {
  const normalizedQuery = normalizeSearch(query.trim());
  if (normalizedQuery.length === 0) return [...options];
  return options.filter((option) => normalizeSearch([
    option.name,
    option.label ?? option.name,
    option.pickerGroup?.label ?? "",
  ].join(" ")).includes(normalizedQuery));
};

export const resolveTemplateVariablePickerGroup = (
  option: TemplateVariablePickerOption,
  messages: Pick<TemplateVariablePickerMessages, "groupLabels">,
): TemplateVariablePickerGroupPresentation => {
  if (option.pickerGroup !== undefined) return option.pickerGroup;
  const group: TemplateVariablePickerGroupKey = option.isTextBlock
    ? "text_blocks"
    : option.kind === "channel" ? "channel" : option.group ?? "context";
  return {
    id: `host:${group}`,
    label: messages.groupLabels[group],
    iconName: hostGroupIcons[group],
    order: hostGroupOrder[group],
  };
};

export const groupTemplateVariableOptions = (
  options: readonly TemplateVariablePickerOption[],
  messages: Pick<TemplateVariablePickerMessages, "groupLabels">,
  includeChannelGroup = false,
): GroupedTemplateVariableOptions[] => {
  const grouped = new Map<string, { group: TemplateVariablePickerGroupPresentation; options: { option: TemplateVariablePickerOption; index: number }[] }>();
  options.forEach((option, index) => {
    const group = resolveTemplateVariablePickerGroup(option, messages);
    const existing = grouped.get(group.id);
    if (existing === undefined) grouped.set(group.id, { group, options: [{ option, index }] });
    else existing.options.push({ option, index });
  });
  if (includeChannelGroup && !grouped.has("host:channel")) {
    const group = resolveTemplateVariablePickerGroup({ name: "var", description: "", sample: "", kind: "channel" }, messages);
    grouped.set(group.id, { group, options: [] });
  }
  return [...grouped.values()].sort((left, right) => left.group.order - right.group.order);
};

export const reindexGroupedTemplateVariableOptions = (
  groups: readonly GroupedTemplateVariableOptions[],
): GroupedTemplateVariableOptions[] => {
  let index = 0;
  return groups.map(({ group, options }) => ({
    group,
    options: options.map(({ option }) => ({ option, index: index++ })),
  }));
};

export const prioritizeTemplateVariableNamespace = (
  groups: readonly GroupedTemplateVariableOptions[],
  query: string,
): GroupedTemplateVariableOptions[] => {
  const namespace = /^([A-Za-z][A-Za-z0-9_]*)\./u.exec(query.trim())?.[1]?.toLowerCase();
  if (namespace === undefined) return [...groups];
  const targetGroup = namespace === "var" ? "host:channel" : namespace;
  const matchingIndex = groups.findIndex(({ group }) => group.id.toLowerCase() === targetGroup || group.id.toLowerCase() === `module:${namespace}`);
  if (matchingIndex <= 0) return [...groups];
  const result = [...groups];
  const [activeGroup] = result.splice(matchingIndex, 1);
  if (activeGroup !== undefined) result.unshift(activeGroup);
  return result;
};
