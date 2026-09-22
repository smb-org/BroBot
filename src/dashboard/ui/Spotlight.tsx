import "@mantine/spotlight/styles.css";

import { Spotlight as MantineSpotlight, type SpotlightActionData, type SpotlightFilterFunction } from "@mantine/spotlight";

export interface SpotlightItem {
  id: string;
  label: string;
  /** Shown under the label; a disabled item's reason replaces this. */
  description?: string;
  /** Result group heading ("Module", "Textbefehle", "Mitglieder", "Aktionen" -- caller decides). */
  group?: string;
  /** Terms matched in addition to the label/description (e.g. an English + German alias). */
  keywords?: string[];
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

/**
 * The default filter requires every *word* in the query to appear
 * somewhere in an action's label/description/keywords -- wrong for a
 * parametrized action ("shoutout streamerin" has no action whose text
 * contains "streamerin"). This instead: substring-matches the whole query
 * against label/description, and for keywords accepts either direction of
 * prefix match, so a keyword can be a command word the query extends
 * ("ads" keyword matches query "ads off") or the query can extend toward a
 * longer keyword as the user keeps typing.
 */
const filterItems: SpotlightFilterFunction = (query, actions) => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return actions;
  return actions.filter((action) => {
    if ("actions" in action) return true;
    const label = (action.label ?? "").toLowerCase();
    const description = (action.description ?? "").toLowerCase();
    if (label.includes(q) || description.includes(q)) return true;
    const keywords = Array.isArray(action.keywords)
      ? action.keywords
      : typeof action.keywords === "string" ? action.keywords.split(",") : [];
    return keywords.some((keyword: string) => {
      const normalized = keyword.trim().toLowerCase();
      return normalized.length > 0 && (q.startsWith(normalized) || normalized.startsWith(q));
    });
  });
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
  const actions: SpotlightActionData[] = items.map((item) => {
    const description = item.disabled ? item.disabledReason ?? item.description : item.description;
    return {
      id: item.id,
      label: item.label,
      ...(item.group === undefined ? {} : { group: item.group }),
      ...(item.keywords === undefined ? {} : { keywords: item.keywords }),
      ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
      ...(description === undefined ? {} : { description }),
      ...(item.disabled === true ? {} : { onClick: item.onTrigger }),
    };
  });

  return (
    <MantineSpotlight
      actions={actions}
      filter={filterItems}
      nothingFound={emptyMessage}
      searchProps={{ placeholder }}
      {...(forceOpened === undefined ? {} : { forceOpened })}
      {...(query === undefined ? {} : { query })}
      {...(onQueryChange === undefined ? {} : { onQueryChange })}
      {...(onOpen === undefined ? {} : { onSpotlightOpen: onOpen })}
    />
  );
}
