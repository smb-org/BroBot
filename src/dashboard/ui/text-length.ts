/** Length of a text field's value in its declared unit (UTF-16 units unless `codePoints`). */
export const textFieldLength = (field: { lengthUnit?: "utf16" | "codePoints" }, value: string): number =>
  field.lengthUnit === "codePoints" ? Array.from(value).length : value.length;
