interface ChatTextCharacter {
  value: string;
  fragmentIndex: number;
}

const invisibleChatFillers = new Set([
  "\u{E0000}",
  "\u034F",
  "\u200B",
  "\u200C",
  "\u2060",
  "\uFEFF",
]);
const extendedPictographic = /\p{Extended_Pictographic}/u;
const emojiModifier = /\p{Emoji_Modifier}/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const keepChatTextCharacter = (characters: readonly ChatTextCharacter[], index: number): boolean => {
  const character = characters[index]?.value;
  if (character === "\u200D") {
    let previous = index - 1;
    while (previous >= 0 && (characters[previous]?.value === "\uFE0E" || characters[previous]?.value === "\uFE0F" ||
        characters[previous]?.value === "\u20E3" || emojiModifier.test(characters[previous]?.value ?? ""))) {
      previous -= 1;
    }
    return previous >= 0 && extendedPictographic.test(characters[previous]?.value ?? "") &&
      extendedPictographic.test(characters[index + 1]?.value ?? "");
  }
  return character !== undefined && !invisibleChatFillers.has(character);
};

const visibleCharacters = (characters: readonly ChatTextCharacter[]): ChatTextCharacter[] =>
  characters.filter((_character, index) => keepChatTextCharacter(characters, index));

const charactersForText = (text: string, fragmentIndex = 0): ChatTextCharacter[] =>
  Array.from(text, (value) => ({ value, fragmentIndex }));

const textFromCharacters = (characters: readonly ChatTextCharacter[]): string =>
  characters.map(({ value }) => value).join("");

const normalizeChatText = (text: string): string =>
  textFromCharacters(visibleCharacters(charactersForText(text))).trim();

const normalizeFragments = (fragments: readonly unknown[], normalizedText: string): unknown[] => {
  const fragmentTexts = fragments.map((fragment) =>
    isRecord(fragment) && typeof fragment.text === "string" ? fragment.text : null);
  if (fragmentTexts.some((text) => text === null)) {
    return fragments.map((fragment) => {
      if (!isRecord(fragment) || typeof fragment.text !== "string") return fragment;
      return { ...fragment, text: textFromCharacters(visibleCharacters(charactersForText(fragment.text))) };
    });
  }

  const characters = fragmentTexts.flatMap((text, fragmentIndex) => charactersForText(text as string, fragmentIndex));
  const visible = visibleCharacters(characters);
  const visibleText = textFromCharacters(visible);
  const shouldTrim = visibleText.trim() === normalizedText;
  const start = shouldTrim ? visibleText.length - visibleText.trimStart().length : 0;
  const end = shouldTrim ? visibleText.trimEnd().length : visibleText.length;
  const normalizedTexts = Array.from({ length: fragments.length }, () => "");
  let offset = 0;
  for (const character of visible) {
    const nextOffset = offset + character.value.length;
    if (nextOffset > start && offset < end) {
      normalizedTexts[character.fragmentIndex] = `${normalizedTexts[character.fragmentIndex] ?? ""}${character.value}`;
    }
    offset = nextOffset;
  }

  return fragments.map((fragment, index) => {
    if (!isRecord(fragment)) return fragment;
    return { ...fragment, text: normalizedTexts[index] ?? "" };
  });
};

/** Removes invisible chat duplicate suffixes while preserving emoji ZWJ sequences. */
export const normalizeChatMessagePayload = (
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const message = payload.message;
  if (typeof message === "string") return { ...payload, message: normalizeChatText(message) };
  if (!isRecord(message) || typeof message.text !== "string") return payload;

  const normalizedText = normalizeChatText(message.text);
  return {
    ...payload,
    message: {
      ...message,
      text: normalizedText,
      ...(Array.isArray(message.fragments)
        ? { fragments: normalizeFragments(message.fragments, normalizedText) }
        : {}),
    },
  };
};
