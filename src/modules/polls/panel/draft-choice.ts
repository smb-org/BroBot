/** A choice row with a stable key, so the input keeps focus while its text changes. */
export interface PollsDraftChoice { key: string; text: string }

let choiceKeyCounter = 0;
export const newDraftChoice = (text = ""): PollsDraftChoice => ({ key: `choice-${String(++choiceKeyCounter)}`, text });
