const EVENT_TEXT_MAXIMUM_LENGTH = 200;

/** Kürzt protokollierte Texte sichtbar auf höchstens 200 Zeichen. */
export const kuerzeAuf200Zeichen = (text: string): string =>
  text.length <= EVENT_TEXT_MAXIMUM_LENGTH
    ? text
    : `${text.slice(0, EVENT_TEXT_MAXIMUM_LENGTH - 1)}…`;
