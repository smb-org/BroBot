/** Length of a text field's value in its declared unit (UTF-16 units unless `codePoints`). */
export const textFieldLength = (field: { lengthUnit?: "utf16" | "codePoints" }, value: string): number =>
  field.lengthUnit === "codePoints" ? Array.from(value).length : value.length;

export const formatCharacterCount = (count: number, maximum: number, language: "de" | "en"): string =>
  `${String(count)} / ${String(maximum)} ${language === "en" ? "characters" : "Zeichen"}`;

export const formatCharacterTotal = (count: number, language: "de" | "en"): string =>
  `${String(count)} ${language === "en" ? "characters" : "Zeichen"}`;
