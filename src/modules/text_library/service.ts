import type { TextBlock, TextBlockCategory } from "./contracts";
import type { TextBlockActor } from "./types";
import type { TextBlockInput, TextBlockMutationResult, TextBlockRepository, TextLibrarySnapshot } from "./repository";
import { validateTextBlockGraph, type TextBlockGraphError } from "./domain";
import type { ModuleTemplateUsageSource } from "../contract";

const graphError = (blocks: readonly TextBlock[], candidate: TextBlockInput): TextBlockGraphError | null => {
  const graph = new Map<string, Pick<TextBlock, "name" | "variants">>(
    blocks.map((block) => [block.name, block]),
  );
  graph.set(candidate.name, { name: candidate.name, variants: candidate.variants });
  return validateTextBlockGraph(graph);
};

export interface TextLibraryService {
  list(channelId: string, usageSources?: readonly ModuleTemplateUsageSource[]): Promise<TextLibrarySnapshot>;
  find(channelId: string, name: string): Promise<TextBlock | null>;
  create(input: TextBlockInput, actor: TextBlockActor): Promise<TextBlockMutationResult>;
  change(input: TextBlockInput, actor: TextBlockActor): Promise<TextBlockMutationResult>;
  delete(channelId: string, name: string, revision: number, graphRevision: number, actor: TextBlockActor, now: string): Promise<TextBlockMutationResult>;
  createCategory(channelId: string, name: string, actor: TextBlockActor, now: string): Promise<TextBlockCategory | null>;
  renameCategory(channelId: string, categoryId: string, name: string, actor: TextBlockActor, now: string): Promise<{ ok: boolean }>;
  deleteCategory(channelId: string, categoryId: string, actor: TextBlockActor, now: string): Promise<"ok" | "not_found" | "not_empty">;
  updateTimeZone(channelId: string, timeZone: string, revision: number, actor: TextBlockActor, now: string): Promise<boolean>;
}

export const createTextLibraryService = (repository: TextBlockRepository): TextLibraryService => ({
  list: (channelId, usageSources) => repository.list(channelId, usageSources),
  find: (channelId, name) => repository.find(channelId, name),
  async create(input, actor) {
    const snapshot = await repository.list(input.channelId);
    const invalid = graphError(snapshot.blocks, input);
    if (invalid !== null) return { ok: false, reason: invalid.reason, path: invalid.path };
    return repository.create(input, actor);
  },
  async change(input, actor) {
    const snapshot = await repository.list(input.channelId);
    const invalid = graphError(snapshot.blocks, input);
    if (invalid !== null) return { ok: false, reason: invalid.reason, path: invalid.path };
    return repository.change(input, actor);
  },
  delete: (channelId, name, revision, graphRevision, actor, now) =>
    repository.delete(channelId, name, revision, graphRevision, actor, now),
  createCategory: (channelId, name, actor, now) => repository.createCategory(channelId, name, actor, now),
  renameCategory: (channelId, categoryId, name, actor, now) => repository.renameCategory(channelId, categoryId, name, actor, now),
  deleteCategory: (channelId, categoryId, actor, now) => repository.deleteCategory(channelId, categoryId, actor, now),
  updateTimeZone: (channelId, timeZone, revision, actor, now) => repository.updateTimeZone(channelId, timeZone, revision, actor, now),
});
