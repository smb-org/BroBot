interface TextareaInsertion {
  value: string;
  caret: number;
}

export const insertTextareaText = (
  textarea: HTMLTextAreaElement,
  insertion: string,
  start: number,
  end: number,
): TextareaInsertion => {
  const nextValue = `${textarea.value.slice(0, start)}${insertion}${textarea.value.slice(end)}`;
  textarea.focus();
  textarea.setSelectionRange(start, end);

  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- insertText preserves native textarea undo history.
    textarea.ownerDocument.execCommand("insertText", false, insertion);
  } catch {
    // Older browsers and DOM test environments may not implement insertText.
  }

  if (textarea.value !== nextValue) textarea.setRangeText(insertion, start, end, "end");
  const caret = start + insertion.length;
  if (textarea.selectionStart !== caret || textarea.selectionEnd !== caret) {
    textarea.setSelectionRange(caret, caret);
  }
  return { value: nextValue, caret };
};
