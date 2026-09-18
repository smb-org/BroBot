/**
 * Übergangstyp für bereits ausgerollte Umgebungen. Der Worker liest den alten
 * Namen nur noch als Fallback; seine Entfernung erfolgt später separat.
 */
interface Env {
  SESSION_ENCRYPTION_KEYS?: string;
}
