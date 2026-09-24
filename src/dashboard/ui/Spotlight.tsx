import "@mantine/spotlight/styles.css";

import { Spotlight as MantineSpotlight, type SpotlightActionData, type SpotlightFilterFunction } from "@mantine/spotlight";
import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

type SpotlightActionGroupData = { group: string; actions: SpotlightActionData[] };
type SpotlightActions = SpotlightActionData | SpotlightActionGroupData;

export interface SpotlightItem {
  id: string;
  label: string;
  /** Shown under the label; a disabled item's reason replaces this. */
  description?: string;
  /** Result group heading ("Module", "Textbefehle", "Mitglieder", "Aktionen" -- caller decides). */
  group?: string;
  /** Terms matched in addition to the label/description (e.g. an English + German alias). */
  keywords?: string[];
  icon?: IconName | Exclude<ReactNode, string>;
  disabled?: boolean;
  disabledReason?: string;
  onTrigger: () => void;
}

export interface SpotlightProps {
  items: SpotlightItem[];
  emptyMessage: string;
  placeholder?: string;
  /** Forces the modal open; only meant for tests -- the real trigger is the built-in mod+K shortcut. */
  forceOpened?: boolean;
  /** Controlled query, for a caller that needs to read what's typed (a
   *  parametrized action like "shoutout &lt;login&gt;") -- optional, an
   *  uncontrolled search works for every other result kind. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Fires when the modal opens -- the hook for a caller that loads its
   *  result data lazily instead of prefetching on every mount. */
  onOpen?: () => void;
}

/** Lowercased and diacritic-stripped (drops combining marks after NFD, e.g. "o" from an umlauted "o") so an accent-free query still matches an accented label or keyword (#208). */
const fold = (value: string): string => value.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();

/**
 * The default filter requires every *word* in the query to appear
 * somewhere in an action's label/description/keywords -- wrong for a
 * parametrized action ("shoutout streamerin" has no action whose text
 * contains "streamerin"). This instead: substring-matches the whole query
 * against label/description/group, and for keywords accepts either
 * direction of prefix match, so a keyword can be a command word the query
 * extends ("ads" keyword matches query "ads off") or the query can extend
 * toward a longer keyword as the user keeps typing. Matching folds case and
 * diacritics on both sides (#208), so a page's own group heading (e.g.
 * "Betrieb") is itself a match target, not just its label and keywords.
 */
const flatActions = (actions: SpotlightActions[]): SpotlightActionData[] => actions.flatMap((action) =>
  "actions" in action ? action.actions.map((item) => ({ ...item, group: action.group })) : [action],
);

const groupedActions = (actions: SpotlightActionData[]): SpotlightActions[] => {
  const result: SpotlightActions[] = [];
  const groups = new Map<string, SpotlightActionData[]>();
  for (const action of actions) {
    if (action.group === undefined) {
      result.push(action);
      continue;
    }
    const group = groups.get(action.group);
    if (group === undefined) {
      const members: SpotlightActionData[] = [];
      groups.set(action.group, members);
      result.push({ group: action.group, actions: members });
      members.push(action);
    } else {
      group.push(action);
    }
  }
  return result;
};

const filterItems: SpotlightFilterFunction = (query, actions) => {
  const q = fold(query.trim());
  const filtered = flatActions(actions).filter((action) => {
    if (q.length === 0) return true;
    const label = fold(action.label ?? "");
    const description = fold(action.description ?? "");
    const group = fold(typeof action.group === "string" ? action.group : "");
    if (label.includes(q) || description.includes(q) || group.includes(q)) return true;
    const keywords = Array.isArray(action.keywords)
      ? action.keywords
      : typeof action.keywords === "string" ? action.keywords.split(",") : [];
    return keywords.some((keyword: string) => {
      const normalized = fold(keyword.trim());
      return normalized.length > 0 && (q.startsWith(normalized) || normalized.startsWith(q));
    });
  });
  return groupedActions(filtered);
};

/**
 * Wraps `@mantine/spotlight` (chosen over a hand-built command palette: it
 * already gives modal focus-trapping, the mod+K shortcut, arrow-key
 * navigation, and Escape-to-close for free -- see the Spotlight commit's
 * message for the size comparison against building this from Mantine core
 * parts). `items` stays in project vocabulary; only this file touches the
 * package's own types.
 */
export function Spotlight({ items, emptyMessage, placeholder, forceOpened, query, onQueryChange, onOpen }: SpotlightProps) {
  const actionItems: SpotlightActionData[] = items.map((item) => {
    const description = item.disabled ? item.disabledReason ?? item.description : item.description;
    const leftSection = typeof item.icon === "string"
      ? <Icon name={item.icon as IconName} size={20} />
      : item.icon;
    return {
      id: item.id,
      label: item.label,
      ...(leftSection === undefined ? {} : { leftSection }),
      ...(item.group === undefined ? {} : { group: item.group }),
      ...(item.keywords === undefined ? {} : { keywords: item.keywords }),
      ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
      ...(description === undefined ? {} : { description }),
      ...(item.disabled === true ? {} : { onClick: item.onTrigger }),
    };
  });
  const actions = groupedActions(actionItems);

  return (
    <MantineSpotlight
      actions={actions}
      filter={filterItems}
      nothingFound={emptyMessage}
      searchProps={{ placeholder, leftSection: <Icon name="search" size={20} /> }}
      {...(forceOpened === undefined ? {} : { forceOpened })}
      {...(query === undefined ? {} : { query })}
      {...(onQueryChange === undefined ? {} : { onQueryChange })}
      {...(onOpen === undefined ? {} : { onSpotlightOpen: onOpen })}
    />
  );
}
