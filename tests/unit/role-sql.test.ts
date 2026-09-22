import { describe, expect, it } from "vitest";

import {
  actorGuard,
  channelBotConsentCondition,
  lastBroadcasterGuard,
  lastBroadcasterRoleChangeGuard,
  requiredActorRoles,
  sqlRole,
  sqlRoleList,
} from "../../src/worker/db/guards";
import { platformRolesSql } from "../../src/worker/platform/repository";
import { overlayTokenRoles } from "../../src/worker/auth/overlay-token-repository";
import { CHANNEL_ROLES, MANAGING_ROLES, PLATFORM_ASSIGNABLE_ROLES } from "../../src/contracts/values";

/**
 * `db/guards.ts` used to take role lists as pre-rendered SQL strings
 * (`actorGuard("'broadcaster', 'manager'")`), and several files each held
 * their own copy of the same literal. This is a security-critical path --
 * SQL renders the actual authorization check -- so the migration to typed
 * `ChannelRole[]` sets rendered through `sqlRole`/`sqlRoleList` must produce
 * byte-identical SQL to what those literals produced. Every expected string
 * below is transcribed (via `git show` of the pre-refactor file) from the
 * old source, not derived from the current helpers, so a bug in
 * `sqlRole`/`sqlRoleList` themselves would still be caught here.
 */
describe("role SQL stays byte-identical after the typed-set migration", () => {
  it("renders a single role literal the same as the old inline literal", () => {
    expect(sqlRole("broadcaster")).toBe("'broadcaster'");
    expect(sqlRole("manager")).toBe("'manager'");
    expect(sqlRole("operator")).toBe("'operator'");
  });

  it("renders a role list the same as the old comma-joined literal", () => {
    expect(sqlRoleList(MANAGING_ROLES)).toBe("'broadcaster', 'manager'");
    expect(sqlRoleList(PLATFORM_ASSIGNABLE_ROLES)).toBe("'manager', 'operator'");
    expect(sqlRoleList(CHANNEL_ROLES)).toBe("'broadcaster', 'manager', 'operator'");
  });

  it("renders actorGuard(CHANNEL_ROLES)'s IN-list the same as the old ANY_MEMBER_ROLES constant", () => {
    expect(actorGuard(CHANNEL_ROLES)).toContain("actor.role IN ('broadcaster', 'manager', 'operator')");
  });

  it("renders actorGuard(MANAGING_ROLES) the same as the old 'broadcaster', 'manager' literal", () => {
    expect(actorGuard(MANAGING_ROLES)).toContain("actor.role IN ('broadcaster', 'manager')");
  });

  it("renders overlayTokenRoles the same as the old string constant", () => {
    expect(sqlRoleList(overlayTokenRoles)).toBe("'broadcaster', 'manager'");
  });

  it("renders platformRolesSql the same as the old string constant", () => {
    expect(platformRolesSql).toBe("'manager', 'operator'");
  });

  it("renders requiredActorRoles the same as the old ternary's string branches", () => {
    // Old: targetRole === "broadcaster" || existingRole === "broadcaster" ? "'broadcaster'" : "'broadcaster', 'manager'"
    expect(sqlRoleList(requiredActorRoles("broadcaster"))).toBe("'broadcaster'");
    expect(sqlRoleList(requiredActorRoles("manager", "broadcaster"))).toBe("'broadcaster'");
    expect(sqlRoleList(requiredActorRoles(undefined, "broadcaster"))).toBe("'broadcaster'");
    expect(sqlRoleList(requiredActorRoles("manager"))).toBe("'broadcaster', 'manager'");
    expect(sqlRoleList(requiredActorRoles(undefined, "manager"))).toBe("'broadcaster', 'manager'");
    expect(sqlRoleList(requiredActorRoles(undefined, undefined))).toBe("'broadcaster', 'manager'");
  });

  // Built with string concatenation, not a template literal, so this file's
  // own indentation can't accidentally change what's being compared against.
  // Whitespace transcribed byte-for-byte from the pre-refactor
  // `soleBroadcasterPredicate`/`lastBroadcasterGuard`/
  // `lastBroadcasterRoleChangeGuard` template literals via `git show`.
  const oldSoleBroadcasterPredicate = "\n" +
    "          AND (\n" +
    "            SELECT COUNT(*)\n" +
    "              FROM channel_members\n" +
    "             WHERE channel_id = ? AND role = 'broadcaster'\n" +
    "          ) <= 1";
  const oldLastBroadcasterGuard = "\n" +
    "        AND NOT (\n" +
    "          role = 'broadcaster'\n" +
    "          " + oldSoleBroadcasterPredicate + "\n" +
    "        )";
  const oldLastBroadcasterRoleChangeGuard = "\n" +
    "        AND NOT (\n" +
    "          role = 'broadcaster'\n" +
    "          AND ? <> 'broadcaster'\n" +
    "          " + oldSoleBroadcasterPredicate + "\n" +
    "        )";

  it("renders lastBroadcasterGuard exactly like the old hand-written template", () => {
    expect(lastBroadcasterGuard).toBe(oldLastBroadcasterGuard);
  });

  it("renders lastBroadcasterRoleChangeGuard exactly like the old hand-written template", () => {
    expect(lastBroadcasterRoleChangeGuard).toBe(oldLastBroadcasterRoleChangeGuard);
  });

  it("leaves the unrelated channel:bot consent condition untouched", () => {
    expect(channelBotConsentCondition("channel")).toContain("broadcaster_identity.status = 'connected'");
  });
});
