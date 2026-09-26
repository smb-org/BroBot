import type { TextBlock, TextBlockCategory, TextLibrarySettings, TextBlockUsage, TextBlockMutationInput } from "./contracts";
import type { TextBlockMutationError } from "./contracts";
import type { TextBlockActor } from "./types";
import type { ModuleTemplateUsageSource } from "../contract";

export interface TextBlockInput extends TextBlockMutationInput {
  channelId: string;
  expectedGraphRevision: number;
  now: string;
}

export type TextBlockMutationResult =
  | { ok: true; block: TextBlock }
  | { ok: false; reason: TextBlockMutationError; current?: TextBlock; path?: readonly string[] };

export interface TextLibrarySnapshot {
  blocks: TextBlock[];
  categories: TextBlockCategory[];
  settings: TextLibrarySettings;
  usages: Readonly<Record<string, readonly TextBlockUsage[]>>;
}

export interface TextBlockRepository {
  initialize(channelId: string, now: string): Promise<void>;
  list(channelId: string, usageSources?: readonly ModuleTemplateUsageSource[]): Promise<TextLibrarySnapshot>;
  find(channelId: string, name: string): Promise<TextBlock | null>;
  create(input: TextBlockInput, actor: TextBlockActor): Promise<TextBlockMutationResult>;
  change(input: TextBlockInput, actor: TextBlockActor): Promise<TextBlockMutationResult>;
  delete(channelId: string, name: string, revision: number, graphRevision: number, actor: TextBlockActor, now: string): Promise<TextBlockMutationResult>;
  renameCategory(channelId: string, categoryId: string, customName: string, actor: TextBlockActor, now: string): Promise<{ ok: boolean }>;
  createCategory(channelId: string, name: string, actor: TextBlockActor, now: string): Promise<TextBlockCategory | null>;
  deleteCategory(channelId: string, categoryId: string, actor: TextBlockActor, now: string): Promise<"ok" | "not_found" | "not_empty">;
  updateTimeZone(channelId: string, timeZone: string, revision: number, actor: TextBlockActor, now: string): Promise<boolean>;
}
