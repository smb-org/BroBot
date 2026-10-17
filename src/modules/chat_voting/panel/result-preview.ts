import type { ModuleLanguage } from "../../contract";
import { chatVotingChatText } from "../contracts/chat-defaults";
import { DEFAULT_CHAT_VOTING_SETTINGS } from "../contracts";

/**
 * Chat text the runtime sends for a closed vote, mirroring the delivery in service.ts:
 * the default text gets the localized "Result for <title>" intro, a custom text is sent
 * as written, and a blank text suppresses delivery (empty string).
 */
export const chatVoteResultPreview = (
  language: ModuleLanguage,
  resultText: string,
  title: string | null,
  result: string,
  values: Readonly<Record<string, string>>,
): string => {
  if (resultText.trim().length === 0) return "";
  if (resultText === DEFAULT_CHAT_VOTING_SETTINGS.resultText) {
    return title === null ? result : chatVotingChatText(language, "result", undefined, undefined, undefined, title, result);
  }
  return resultText.replace(/\{([^{}]+)\}/gu, (token, name: string) => values[name] ?? token);
};
