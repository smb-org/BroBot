const DIACRITIC_MARKS = /\p{M}+/gu;
const PUNCTUATION = /\p{P}+/gu;
const SPACES = /\s+/gu;

export const normalizeBlitzAnswer = (value: string): string => value
  .toLocaleLowerCase("de-DE")
  .replaceAll("\u00e4", "ae")
  .replaceAll("\u00f6", "oe")
  .replaceAll("\u00fc", "ue")
  .replaceAll("\u00df", "ss")
  .normalize("NFD")
  .replace(DIACRITIC_MARKS, "")
  .replace(PUNCTUATION, "")
  .replace(SPACES, " ")
  .trim();

export const scrambleBlitzWord = (value: string): string => {
  const solution = value.toLocaleUpperCase("de-DE");
  const original = Array.from(solution);
  if (original.length < 2 || new Set(original).size < 2) throw new Error("scramble_word_invalid");
  let shuffled = solution;
  while (shuffled === solution) {
    const letters = [...original];
    const randomValues = new Uint32Array(letters.length - 1);
    crypto.getRandomValues(randomValues);
    for (let index = letters.length - 1; index > 0; index -= 1) {
      const random = randomValues[letters.length - 1 - index] ?? 0;
      const otherIndex = random % (index + 1);
      [letters[index], letters[otherIndex]] = [letters[otherIndex] ?? "", letters[index] ?? ""];
    }
    shuffled = letters.join("");
  }
  return shuffled;
};

export interface BlitzWinner {
  accountId: string;
  login: string;
}
