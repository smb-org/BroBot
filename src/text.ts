const EREIGNIS_TEXT_MAXIMALE_LAENGE = 200;

/** Kürzt protokollierte Texte sichtbar auf höchstens 200 Zeichen. */
export const kuerzeAuf200Zeichen = (text: string): string =>
  text.length <= EREIGNIS_TEXT_MAXIMALE_LAENGE
    ? text
    : `${text.slice(0, EREIGNIS_TEXT_MAXIMALE_LAENGE - 1)}…`;
