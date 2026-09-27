import type { ModuleTemplateMinimumTier } from "../../contract";
import { TEMPLATE_BARE_VARIABLE_NAME_PATTERN } from "../../../contracts/template-names";

export {
  TEXT_LIBRARY_LIBRARY_PATH,
} from "../../contracts/text-library";
export type { TextLibraryBlockSummary } from "../../contracts/text-library";

export const TEXT_BLOCK_NAME_PATTERN = TEMPLATE_BARE_VARIABLE_NAME_PATTERN;
export const TEXT_BLOCK_MAXIMUMS = {
  blocksPerChannel: 200,
  variantsPerBlock: 10,
  textsPerVariant: 10,
  categoriesPerChannel: 25,
  categoryNameLength: 40,
  textLength: 500,
  renderedLength: 500,
  nestingDepth: 3,
} as const;

export interface TwitchGame {
  id: string;
  name: string;
  /** Helix box_art_url template; absent on older persisted game entries. */
  boxArtUrlTemplate?: string;
}

export interface TextBlockConditions {
  stream?: "online" | "offline";
  game?: { mode: "is" | "is_not"; game: TwitchGame };
  minimumTier?: ModuleTemplateMinimumTier;
  weekdays?: readonly number[];
  timeWindow?: { start: string; end: string };
  /** Conditions contributed by registered data-source modules, keyed by their dotted id. */
  data?: Readonly<Record<string, string>>;
}

export interface TextBlockVariant {
  id: string;
  conditions: TextBlockConditions;
  texts: readonly string[];
}

export interface TextBlockCategory {
  id: string;
  catalogKey: "social" | "info" | "faq" | "game" | "fun" | null;
  customName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TextBlock {
  channelId: string;
  name: string;
  categoryId: string;
  games: readonly TwitchGame[];
  variants: readonly TextBlockVariant[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Editable block payload shared by the panel service and module routes. */
export interface TextBlockMutationInput {
  name: string;
  categoryId: string;
  games: readonly TwitchGame[];
  variants: readonly TextBlockVariant[];
}

export interface TextBlockSaveInput extends TextBlockMutationInput {
  revision: number;
}

export interface TextLibrarySettings {
  revision: number;
  graphRevision: number;
  updatedAt: string;
}

export interface TextBlockUsage {
  kind: "command" | "timer" | "overlay" | "event";
  label: string;
}

export interface TextLibraryData {
  blocks: TextBlock[];
  categories: TextBlockCategory[];
  settings: TextLibrarySettings;
  usages: Readonly<Record<string, readonly TextBlockUsage[]>>;
  reservedNames?: readonly string[];
  dataConditionValues?: Readonly<Record<string, string>>;
}

export type TextBlockMutationError =
  | "already_exists"
  | "not_found"
  | "conflict"
  | "category_not_found"
  | "category_not_empty"
  | "limit_reached"
  | "invalid_block"
  | "reference_cycle"
  | "reference_depth_exceeded"
  | "not_authorized";

export const DEFAULT_TEXT_BLOCK_CATEGORIES = [
  { id: "social", catalogKey: "social" },
  { id: "info", catalogKey: "info" },
  { id: "faq", catalogKey: "faq" },
  { id: "game", catalogKey: "game" },
  { id: "fun", catalogKey: "fun" },
] as const;
