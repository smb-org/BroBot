import type { QuizSet, QuizSetPage } from "./contracts";

export interface QuizSetRepository {
  list(channelId: string, page: number, search?: string): Promise<QuizSetPage>;
  get(channelId: string, setId: string): Promise<QuizSet | null>;
}
