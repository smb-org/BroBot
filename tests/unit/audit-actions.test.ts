import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "../../src/contracts/values";
import { platformTexts } from "../../src/dashboard/labels";
import { auditActionLabel } from "../../src/dashboard/locale";

/**
 * `AUDIT_ACTIONS` is `audit_log.action`'s closed vocabulary -- see the type's
 * doc comment in `src/contracts/values.ts`. Same belt-and-suspenders as
 * `tests/unit/event-codes.test.ts` and `tests/unit/detail-keys.test.ts`: a
 * cast can still slip a German value past the compiler-checked union.
 */
describe("audit actions", () => {
  it("lets no German action through", () => {
    const suspicious = AUDIT_ACTIONS.filter((action) => /[äöüÄÖÜß]|freigegeben|geaendert|hinzugefuegt|entfernt|aktiviert|deaktiviert|angelegt|kanal|mitglied|modul(?!e)|befehl/.test(action));
    expect(suspicious).toEqual([]);
  });

  it("gives every platform-visible action a label in both languages", () => {
    const platformActions = ["channel.released", "channel.full_consent_changed", "member.added", "member.role_changed", "member.removed"] as const;
    for (const action of platformActions) {
      expect(AUDIT_ACTIONS as readonly string[], action).toContain(action);
      expect(platformTexts("de").actionLabel[action], action).toBeDefined();
      expect(platformTexts("en").actionLabel[action], action).toBeDefined();
    }
  });

  it("labels the overlay token actions in both languages", () => {
    expect(auditActionLabel("overlay.token.issued", "de")).toBe("Overlay-Token ausgestellt");
    expect(auditActionLabel("overlay.token.issued", "en")).toBe("Overlay token issued");
    expect(auditActionLabel("overlay.token.revoked", "de")).toBe("Overlay-Token widerrufen");
    expect(auditActionLabel("overlay.token.revoked", "en")).toBe("Overlay token revoked");
  });

  it("labels every closed audit action in both languages", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(auditActionLabel(action, "de"), action).not.toBe(action);
      expect(auditActionLabel(action, "en"), action).not.toBe(action);
    }
  });

  it("uses the audit writer action type as the writer call-site guard", () => {
    // `recordAudit` and `prepareAudit` accept `AuditWriteAction`; module audit
    // entries use that same type, so undeclared writer actions fail typecheck.
    expect(AUDIT_ACTIONS).toContain("overlay.token.issued");
    expect(AUDIT_ACTIONS).toContain("overlay.token.revoked");
  });
});
