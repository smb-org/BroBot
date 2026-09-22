/**
 * Transitional type for already-deployed environments. The worker only
 * reads the old name as a fallback; its removal will happen separately later.
 */
interface Env {
  SESSION_ENCRYPTION_KEYS?: string;
}
