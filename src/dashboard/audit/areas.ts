import { AUDIT_AREAS, type AuditArea } from "../../contracts/values";

/**
 * Every `AuditWriteAction` sorts into exactly one area by its prefix. Order
 * matters: `text_commands.command.*` and `member.*`/`channel.*`/`overlay.*`
 * are checked before the `"module"` catch-all, which is why `module` isn't
 * itself keyed on a prefix here. `worker/panel/repository.ts`'s SQL filter
 * mirrors this same table so the "area" filter and the family icon
 * (`dashboard/audit/model.ts`) can't drift apart.
 *
 * Kept dependency-free (no locale/labels/ui imports) so the worker can
 * import it directly, the same way it already imports `eventToneEntries`
 * from `dashboard/locale.ts`.
 */
export const AUDIT_AREA_PREFIXES: readonly { area: Exclude<AuditArea, "module">; prefix: string }[] = [
  { area: "command", prefix: "text_commands.command." },
  { area: "member", prefix: "member." },
  { area: "overlay", prefix: "overlay." },
  { area: "channel", prefix: "channel." },
];

export const auditAreaForAction = (action: string): AuditArea =>
  AUDIT_AREA_PREFIXES.find(({ prefix }) => action.startsWith(prefix))?.area ?? "module";

/** Validates a query param / route filter value against the closed `AUDIT_AREAS` vocabulary. */
export const isAuditArea = (value: string): value is AuditArea => (AUDIT_AREAS as readonly string[]).includes(value);

const parseObject = (json: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/** Extracts the target member's user id for #181's subject enrichment -- called worker-side against the raw `before_json`/`after_json`. */
export const auditSubjectUserId = (action: string, beforeJson: string, afterJson: string): string | null => {
  if (auditAreaForAction(action) !== "member") return null;
  const record = parseObject(afterJson) ?? parseObject(beforeJson);
  return record !== null && typeof record.userId === "string" ? record.userId : null;
};
