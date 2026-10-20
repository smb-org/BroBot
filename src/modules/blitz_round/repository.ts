import type { BlitzQuestion, BlitzQuestionInput, BlitzQuestionPage } from "./contracts";

export interface BlitzQuestionRepository {
  list(channelId: string, page: number, search?: string): Promise<BlitzQuestionPage>;
  get(channelId: string, questionId: string): Promise<BlitzQuestion | null>;
  create(channelId: string, input: BlitzQuestionInput, now: string): Promise<BlitzQuestion>;
  update(channelId: string, questionId: string, input: BlitzQuestionInput, now: string): Promise<BlitzQuestion | null>;
  delete(channelId: string, questionId: string): Promise<boolean>;
  enabledCount(channelId: string): Promise<number>;
  pick(channelId: string): Promise<BlitzQuestion | null>;
  markUsed(channelId: string, questionId: string, now: string): Promise<void>;
  seed(channelId: string, words: readonly string[], now: string): Promise<number>;
}
