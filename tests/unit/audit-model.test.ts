import { describe, expect, it } from "vitest";

import type { PanelAuditEntry } from "../../src/panel-contract";
import {
  auditActorLabel,
  auditAreaForAction,
  auditAreaIcon,
  auditDayGroups,
  auditDiffRows,
  auditDiffValueText,
  auditFilterIsActive,
  auditRowLabel,
  auditSubjectText,
  emptyAuditFilter,
} from "../../src/dashboard/audit/model";

const baseEntry = (overrides: Partial<PanelAuditEntry>): PanelAuditEntry => ({
  auditId: "audit-1",
  actorUserId: "user-1",
  actorLogin: null,
  actorDisplayName: null,
  actorKind: "member",
  createdAt: "2026-09-18T04:00:00.000Z",
  moduleId: null,
  action: "module.enabled",
  before: "null",
  after: "{}",
  ...overrides,
});

const boolWords = { on: "An", off: "Aus" };

describe("audit areas", () => {
  it("sorts every prefix into its area, everything else into module", () => {
    expect(auditAreaForAction("text_commands.command.created")).toBe("command");
    expect(auditAreaForAction("member.added")).toBe("member");
    expect(auditAreaForAction("overlay.token.issued")).toBe("overlay");
    expect(auditAreaForAction("channel.released")).toBe("channel");
    expect(auditAreaForAction("module.enabled")).toBe("module");
    expect(auditAreaForAction("ads.settings_changed")).toBe("module");
    expect(auditAreaForAction("clip.created")).toBe("module");
  });

  it("gives every area a distinct icon", () => {
    const icons = new Set((["module", "command", "member", "channel", "overlay"] as const).map(auditAreaIcon));
    expect(icons.size).toBe(5);
  });
});

describe("auditDiffRows", () => {
  it("hides unchanged fields and structural addressing keys", () => {
    const before = JSON.stringify({ channelId: "kanal-a", moduleId: "ads", userId: "user-9", createdAt: "t", updatedAt: "t", enabled: true });
    const after = JSON.stringify({ channelId: "kanal-a", moduleId: "ads", userId: "user-9", createdAt: "t", updatedAt: "t2", enabled: true });
    expect(auditDiffRows(before, after)).toEqual([]);
  });

  it("diffs nested settings JSON (a JSON string inside the JSON) alongside top-level fields", () => {
    const before = JSON.stringify({ channelId: "kanal-a", moduleId: "ads", enabled: true, settings: JSON.stringify({ prewarning: true, leadSeconds: 60 }) });
    const after = JSON.stringify({ channelId: "kanal-a", moduleId: "ads", enabled: true, settings: JSON.stringify({ prewarning: false, leadSeconds: 90 }) });
    const rows = auditDiffRows(before, after);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      { key: "prewarning", kind: "changed", oldValue: true, newValue: false, fromSettings: true },
      { key: "leadSeconds", kind: "changed", oldValue: 60, newValue: 90, fromSettings: true },
    ]));
  });

  it("shows a create entry's fields as added only, skipping null-ish ones", () => {
    const after = JSON.stringify({ channelId: "kanal-a", userId: "user-2", role: "operator", revokedAt: null });
    const rows = auditDiffRows("null", after);
    expect(rows).toEqual([{ key: "role", kind: "added", oldValue: undefined, newValue: "operator", fromSettings: false }]);
  });

  it("shows a remove entry's fields as removed only, skipping null-ish ones", () => {
    const before = JSON.stringify({ channelId: "kanal-a", userId: "user-2", role: "operator", revokedAt: null });
    const rows = auditDiffRows(before, "null");
    expect(rows).toEqual([{ key: "role", kind: "removed", oldValue: "operator", newValue: undefined, fromSettings: false }]);
  });

  it("diffs an array field by value, not by reference", () => {
    const before = JSON.stringify({ aliases: ["a", "b"] });
    const after = JSON.stringify({ aliases: ["a", "c"] });
    expect(auditDiffRows(before, after)).toEqual([{ key: "aliases", kind: "changed", oldValue: ["a", "b"], newValue: ["a", "c"], fromSettings: false }]);
    expect(auditDiffRows(before, before)).toEqual([]);
  });
});

describe("auditDiffValueText", () => {
  it("renders booleans with the caller-supplied words", () => {
    expect(auditDiffValueText(true, boolWords)).toBe("An");
    expect(auditDiffValueText(false, boolWords)).toBe("Aus");
  });

  it("renders null/undefined as a dash and numbers/strings as themselves", () => {
    expect(auditDiffValueText(null, boolWords)).toBe("—");
    expect(auditDiffValueText(undefined, boolWords)).toBe("—");
    expect(auditDiffValueText(90, boolWords)).toBe("90");
    expect(auditDiffValueText("hallo", boolWords)).toBe("hallo");
  });

  it("joins a non-empty array and dashes an empty one", () => {
    expect(auditDiffValueText([], boolWords)).toBe("—");
    expect(auditDiffValueText(["a", "b"], boolWords)).toBe("a, b");
  });
});

describe("auditSubjectText", () => {
  it("names the module for a module-area action", () => {
    const entry = baseEntry({ action: "module.enabled", moduleId: "ads" });
    expect(auditSubjectText(entry, "de")).toBe("Werbung");
    expect(auditSubjectText(entry, "en")).toBe("Ad breaks");
  });

  it("is null for a module-area action without a moduleId", () => {
    expect(auditSubjectText(baseEntry({ action: "module.enabled", moduleId: null }), "de")).toBeNull();
  });

  it("prefixes the command name for a text-command action", () => {
    const entry = baseEntry({ action: "text_commands.command.created", after: JSON.stringify({ name: "hallo" }) });
    expect(auditSubjectText(entry, "de")).toBe("!hallo");
  });

  it("combines the subject's login and role for a member action", () => {
    const entry = baseEntry({
      action: "member.added",
      before: "null",
      after: JSON.stringify({ role: "operator" }),
      subjectLogin: "sensitron",
      subjectDisplayName: null,
    });
    expect(auditSubjectText(entry, "de")).toBe("@sensitron als Bediener");
  });

  it("uses the connector word for the requested language", () => {
    // `roleLabel` (dashboard/labels.ts) has no language parameter of its own
    // -- it always reads the ambient `dashboardLanguage()` -- so only the
    // connector word ("als"/"as") is exercised here per explicit language.
    const entry = baseEntry({
      action: "member.added",
      before: "null",
      after: JSON.stringify({ role: "operator" }),
      subjectLogin: "sensitron",
      subjectDisplayName: null,
    });
    expect(auditSubjectText(entry, "en")).toContain(" as ");
  });

  it("falls back to just the role when the subject's login never resolved", () => {
    const entry = baseEntry({ action: "member.role_changed", after: JSON.stringify({ role: "manager" }) });
    expect(auditSubjectText(entry, "de")).toBe("Verwalter");
  });

  it("is null for a member action with neither a role nor a resolved login", () => {
    expect(auditSubjectText(baseEntry({ action: "member.added", after: "{}" }), "de")).toBeNull();
  });

  it("names the channel login for a platform channel action", () => {
    const entry = baseEntry({ action: "channel.released", before: "null", after: JSON.stringify({ login: "streamerin" }) });
    expect(auditSubjectText(entry, "de")).toBe("@streamerin");
  });

  it("is null for actions with no meaningful subject", () => {
    expect(auditSubjectText(baseEntry({ action: "overlay.token.issued" }), "de")).toBeNull();
    expect(auditSubjectText(baseEntry({ action: "clip.created" }), "de")).toBeNull();
  });
});

describe("auditRowLabel", () => {
  it("appends the subject after the action label", () => {
    expect(auditRowLabel(baseEntry({ action: "module.enabled", moduleId: "ads" }), "de")).toBe("Modul aktiviert: Werbung");
  });

  it("stays just the action label when there's no subject", () => {
    expect(auditRowLabel(baseEntry({ action: "overlay.token.issued" }), "de")).toBe("Overlay-Token ausgestellt");
  });

  it("doesn't repeat the module name for a settings_changed action, whose label already carries it", () => {
    expect(auditRowLabel(baseEntry({ action: "ads.settings_changed", moduleId: "ads" }), "de")).toBe("Einstellungen geändert: Werbung");
  });
});

describe("auditActorLabel", () => {
  it("prefers the display name, then the login, then the raw id", () => {
    expect(auditActorLabel({ actorUserId: "user-1", actorLogin: "alice", actorDisplayName: "Alice" })).toBe("Alice");
    expect(auditActorLabel({ actorUserId: "user-1", actorLogin: "alice", actorDisplayName: null })).toBe("@alice");
    expect(auditActorLabel({ actorUserId: "user-1", actorLogin: null, actorDisplayName: null })).toBe("user-1");
  });
});

describe("auditDayGroups", () => {
  const formatDay = (createdAt: string): string => createdAt.slice(0, 10);

  it("groups entries by calendar day, preserving order", () => {
    const entries = [
      baseEntry({ auditId: "a", createdAt: "2026-09-18T04:00:00.000Z" }),
      baseEntry({ auditId: "b", createdAt: "2026-09-18T02:00:00.000Z" }),
      baseEntry({ auditId: "c", createdAt: "2026-09-17T10:00:00.000Z" }),
    ];
    const groups = auditDayGroups(entries, formatDay);
    expect(groups.map((group) => group.entries.map((entry) => entry.auditId))).toEqual([["a", "b"], ["c"]]);
    expect(groups.map((group) => group.label)).toEqual(["2026-09-18", "2026-09-17"]);
  });

  it("returns no groups for an empty list", () => {
    expect(auditDayGroups([], formatDay)).toEqual([]);
  });
});

describe("audit filters", () => {
  it("is inactive only when both person and area are unset", () => {
    expect(auditFilterIsActive(emptyAuditFilter)).toBe(false);
    expect(auditFilterIsActive({ person: "user-1", area: null })).toBe(true);
    expect(auditFilterIsActive({ person: null, area: "member" })).toBe(true);
  });
});
