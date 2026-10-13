import type { ModuleLanguage } from "../../contract";

export type ApiSourceFunctionGroup = "text" | "number" | "logic" | "list" | "date";

export interface ApiSourceFunction {
  name: string;
  group: ApiSourceFunctionGroup;
  signature: string;
  description: Readonly<Record<ModuleLanguage, string>>;
  example: string;
}

export const API_SOURCE_FUNCTION_CATALOG = [
  { name: "string", group: "text", signature: "string(value)", description: { de: "Wandelt einen Wert in Text um.", en: "Converts a value to text." }, example: '$string(42) → "42"' },
  { name: "substring", group: "text", signature: "substring(text, start, length)", description: { de: "Gibt einen Ausschnitt des Texts zurück.", en: "Returns part of a string." }, example: '$substring("Musterstadt", 0, 6) → "Muster"' },
  { name: "substringBefore", group: "text", signature: "substringBefore(text, delimiter)", description: { de: "Gibt den Text vor dem Trennzeichen zurück.", en: "Returns the text before a delimiter." }, example: '$substringBefore("18:42 Uhr", " ") → "18:42"' },
  { name: "substringAfter", group: "text", signature: "substringAfter(text, delimiter)", description: { de: "Gibt den Text nach dem Trennzeichen zurück.", en: "Returns the text after a delimiter." }, example: '$substringAfter("Wetter: Sonne", ": ") → "Sonne"' },
  { name: "uppercase", group: "text", signature: "uppercase(text)", description: { de: "Wandelt Text in Großbuchstaben um.", en: "Converts text to uppercase." }, example: '$uppercase("hallo") → "HALLO"' },
  { name: "lowercase", group: "text", signature: "lowercase(text)", description: { de: "Wandelt Text in Kleinbuchstaben um.", en: "Converts text to lowercase." }, example: '$lowercase("HALLO") → "hallo"' },
  { name: "trim", group: "text", signature: "trim(text)", description: { de: "Entfernt Leerraum am Anfang und Ende.", en: "Removes whitespace from both ends." }, example: '$trim("  live  ") → "live"' },
  { name: "contains", group: "text", signature: "contains(text, part)", description: { de: "Prüft, ob der Text einen Teiltext enthält.", en: "Checks whether text contains a substring." }, example: '$contains("Stardew Valley", "Valley") → true' },
  { name: "join", group: "text", signature: "join(list, separator)", description: { de: "Verbindet Listenelemente mit einem Trennzeichen.", en: "Joins list items with a separator." }, example: '$join($.days, ", ") → "Mo, Di"' },
  { name: "split", group: "text", signature: "split(text, delimiter)", description: { de: "Teilt Text an einem Trennzeichen in eine Liste.", en: "Splits text into a list at each delimiter." }, example: '$split($.daysText, ",") → ["Mo","Di"]' },
  { name: "replace", group: "text", signature: "replace(text, search, replacement, limit)", description: { de: "Ersetzt passende Textstellen, optional begrenzt.", en: "Replaces matching text, optionally with a limit." }, example: '$replace("Hallo Chat", "Chat", "Leute") → "Hallo Leute"' },
  { name: "number", group: "number", signature: "number(value)", description: { de: "Wandelt einen Wert in eine Zahl um.", en: "Converts a value to a number." }, example: '$number("42") → 42' },
  { name: "sum", group: "number", signature: "sum(list)", description: { de: "Addiert die Zahlen einer Liste.", en: "Adds the numbers in a list." }, example: "$sum($.items) → 5" },
  { name: "max", group: "number", signature: "max(list)", description: { de: "Gibt die größte Zahl einer Liste zurück.", en: "Returns the largest number in a list." }, example: "$max($.items) → 8" },
  { name: "min", group: "number", signature: "min(list)", description: { de: "Gibt die kleinste Zahl einer Liste zurück.", en: "Returns the smallest number in a list." }, example: "$min($.items) → 2" },
  { name: "average", group: "number", signature: "average(list)", description: { de: "Berechnet den Mittelwert einer Zahlenliste.", en: "Calculates the mean of a list of numbers." }, example: "$average($.items) → 3" },
  { name: "round", group: "number", signature: "round(number, digits)", description: { de: "Rundet auf die angegebene Nachkommastelle.", en: "Rounds to the requested number of decimal places." }, example: "$round(3.141, 2) → 3.14" },
  { name: "floor", group: "number", signature: "floor(number)", description: { de: "Rundet auf die nächstkleinere ganze Zahl ab.", en: "Rounds down to the nearest integer." }, example: "$floor(3.8) → 3" },
  { name: "ceil", group: "number", signature: "ceil(number)", description: { de: "Rundet auf die nächstgrößere ganze Zahl auf.", en: "Rounds up to the nearest integer." }, example: "$ceil(3.2) → 4" },
  { name: "abs", group: "number", signature: "abs(number)", description: { de: "Gibt den absoluten Zahlenwert zurück.", en: "Returns the absolute value of a number." }, example: "$abs(-4) → 4" },
  { name: "formatNumber", group: "number", signature: "formatNumber(number, picture)", description: { de: "Formatiert eine Zahl nach einem unterstützten Muster.", en: "Formats a number with a supported picture." }, example: '$formatNumber($.amount, "#,##0.00") → "1,234.00"' },
  { name: "boolean", group: "logic", signature: "boolean(value)", description: { de: "Wandelt einen Wert in Wahr oder Falsch um.", en: "Converts a value to true or false." }, example: "$boolean(1) → true" },
  { name: "not", group: "logic", signature: "not(value)", description: { de: "Kehrt einen Wahrheitswert um.", en: "Inverts a boolean value." }, example: "$not(false) → true" },
  { name: "exists", group: "logic", signature: "exists(value)", description: { de: "Prüft, ob ein Wert vorhanden ist.", en: "Checks whether a value is present." }, example: "$exists($.user) → true" },
  { name: "length", group: "list", signature: "length(value)", description: { de: "Zählt Zeichen oder Elemente.", en: "Counts characters or items." }, example: "$length($.items) → 2" },
  { name: "count", group: "list", signature: "count(list)", description: { de: "Zählt die Elemente einer Liste.", en: "Counts the items in a list." }, example: "$count($.items) → 2" },
  { name: "fromMillis", group: "date", signature: "fromMillis(milliseconds, picture)", description: { de: "Formatiert Millisekunden seit 1970 als Datum oder Uhrzeit.", en: "Formats milliseconds since 1970 as a date or time." }, example: "$fromMillis(0, '[H01]:[m01]') → \"00:00\"" },
  { name: "toMillis", group: "date", signature: "toMillis(date)", description: { de: "Wandelt ein Datum in Millisekunden seit 1970 um.", en: "Converts a date to milliseconds since 1970." }, example: '$toMillis("2026-10-12T10:00:00Z") → 1791799200000' },
  { name: "now", group: "date", signature: "now()", description: { de: "Gibt den aktuellen Zeitpunkt zurück.", en: "Returns the current timestamp." }, example: "$now() → current timestamp" },
] as const satisfies readonly ApiSourceFunction[];
