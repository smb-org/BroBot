import { describe, expect, it } from "vitest";

import { authorizeModuleManagementMutation, authorizeModuleMutation } from "../../src/worker/module-authorization";
import {
  actorGuard,
  requiredActorRoles,
  type ActorContext,
} from "../../src/worker/db/guards";
import {
  createChannelMemberWithAudit,
  deleteChannelMemberWithAudit,
  updateChannelMemberWithAudit,
  type ChannelMemberRecord,
} from "../../src/worker/db/channel-members";
import {
  createChannelModuleWithAudit,
  updateChannelModuleWithAudit,
} from "../../src/worker/db/channel-modules";
import { createOverlayToken, revokeOverlayToken } from "../../src/worker/auth/overlay-token-repository";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import {
  changePlatformMember,
  changeFullConsent,
  removePlatformMember,
  releasePlatformChannel,
  addPlatformMember,
  type PlatformChannel,
} from "../../src/worker/platform/repository";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

type ChannelRole = "broadcaster" | "manager" | "operator";
type RoleRow = ChannelRole | "no member";

const roleRows: readonly RoleRow[] = ["broadcaster", "manager", "operator", "no member"];
const timestamp = "2026-09-18T00:00:00.000Z";
const actor: ActorContext = { userId: "actor", sessionId: "session-actor" };

const allowed = (
  broadcaster: boolean,
  manager: boolean,
  operator: boolean,
  noMember: boolean,
): Record<RoleRow, boolean> => ({
  broadcaster,
  manager,
  operator,
  "no member": noMember,
});

const actionMember = (
  userId: string,
  role: ChannelRole,
  createdAt = timestamp,
  updatedAt = timestamp,
): ChannelMemberRecord => ({
  channelId: "kanal-a",
  userId,
  role,
  createdAt,
  updatedAt,
});

const textCommandRow = (name = "hallo", enabled = true): string =>
  `INSERT INTO text_commands
    (channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds, last_used_at, created_at, updated_at)
   VALUES ('kanal-a', '${name}', 'Hallo {user}', 'text', ${enabled ? "1" : "0"}, 'everyone', 5, NULL, '${timestamp}', '${timestamp}')`;

const overlayTokenRow = (tokenId: string): string =>
  `INSERT INTO overlay_tokens
    (token_id, channel_id, token_hash, expires_at, created_at, revoked_at, revocation_reason, last_used_at)
   VALUES ('${tokenId}', 'kanal-a', 'hash-${tokenId}', NULL, '${timestamp}', NULL, NULL, NULL)`;

interface RoleAction {
  name: string;
  source: string;
  expected: Record<RoleRow, boolean>;
  execute: (database: TestD1Database, role: ChannelRole | null) => Promise<boolean>;
}

const actions: readonly RoleAction[] = [
  {
    name: "Create channel member as operator",
    source: "db/channel-members.ts:createChannelMemberWithAudit + db/guards.ts:actorGuard(requiredActorRoles)",
    expected: allowed(true, true, false, false),
    execute: (database) => createChannelMemberWithAudit(
      database as unknown as D1Database,
      actor,
      actionMember("target", "operator"),
      "member.added",
      timestamp,
      actorGuard(requiredActorRoles("operator")),
    ),
  },
  {
    name: "Create channel member as broadcaster",
    source: "db/channel-members.ts:createChannelMemberWithAudit + db/guards.ts:actorGuard(requiredActorRoles)",
    expected: allowed(true, false, false, false),
    execute: (database) => createChannelMemberWithAudit(
      database as unknown as D1Database,
      actor,
      actionMember("target", "broadcaster"),
      "member.added",
      timestamp,
      actorGuard(requiredActorRoles("broadcaster")),
    ),
  },
  {
    name: "Change channel member from operator to manager",
    source: "db/channel-members.ts:updateChannelMemberWithAudit + db/guards.ts:actorGuard(requiredActorRoles)",
    expected: allowed(true, true, false, false),
    execute: async (database) => {
      await insertMember(database, "kanal-a", "target", "operator");
      return updateChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        actionMember("target", "manager"),
        "member.role_changed",
        timestamp,
        actorGuard(requiredActorRoles("manager", "operator")),
      );
    },
  },
  {
    name: "Change channel member from broadcaster to manager",
    source: "db/channel-members.ts:updateChannelMemberWithAudit + db/guards.ts:lastBroadcasterRoleChangeGuard",
    expected: allowed(true, false, false, false),
    execute: async (database) => {
      await insertMember(database, "kanal-a", "target", "broadcaster");
      const member = actionMember("target", "manager");
      return updateChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        member,
        "member.role_changed",
        timestamp,
        actorGuard(requiredActorRoles(member.role, "broadcaster")),
      );
    },
  },
  {
    name: "Demote the last broadcaster",
    source: "db/channel-members.ts:updateChannelMemberWithAudit + db/guards.ts:lastBroadcasterRoleChangeGuard",
    expected: allowed(false, false, false, false),
    execute: async (database, role) => {
      const target = role === "broadcaster" ? "actor" : "target";
      if (target === "actor") {
        return updateChannelMemberWithAudit(
          database as unknown as D1Database,
          actor,
          actionMember("actor", "manager"),
          "member.role_changed",
          timestamp,
          actorGuard(requiredActorRoles("manager", "broadcaster")),
        );
      }
      await insertMember(database, "kanal-a", target, "broadcaster");
      return updateChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        actionMember(target, "manager"),
        "member.role_changed",
        timestamp,
        actorGuard(requiredActorRoles("manager", "broadcaster")),
      );
    },
  },
  {
    name: "Remove channel member as operator",
    source: "db/channel-members.ts:deleteChannelMemberWithAudit + db/guards.ts:actorGuard + db/guards.ts:lastBroadcasterGuard",
    expected: allowed(true, true, false, false),
    execute: async (database) => {
      await insertMember(database, "kanal-a", "target", "operator");
      return deleteChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        "kanal-a",
        "target",
        "member.removed",
        timestamp,
        actorGuard(requiredActorRoles(undefined, "operator")),
      );
    },
  },
  {
    name: "Remove a non-last broadcaster",
    source: "db/channel-members.ts:deleteChannelMemberWithAudit + db/guards.ts:lastBroadcasterGuard",
    expected: allowed(true, false, false, false),
    execute: async (database) => {
      await insertMember(database, "kanal-a", "target", "broadcaster");
      return deleteChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        "kanal-a",
        "target",
        "member.removed",
        timestamp,
        actorGuard(requiredActorRoles(undefined, "broadcaster")),
      );
    },
  },
  {
    name: "Remove the last broadcaster",
    source: "db/channel-members.ts:deleteChannelMemberWithAudit + db/guards.ts:lastBroadcasterGuard",
    expected: allowed(false, false, false, false),
    execute: async (database, role) => {
      const target = role === "broadcaster" ? "actor" : "target";
      if (target !== "actor") await insertMember(database, "kanal-a", target, "broadcaster");
      return deleteChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        "kanal-a",
        target,
        "member.removed",
        timestamp,
        actorGuard(requiredActorRoles(undefined, "broadcaster")),
      );
    },
  },
  {
    name: "Enable module",
    source: "db/channel-modules.ts:createChannelModuleWithAudit + db/guards.ts:actorGuard",
    expected: allowed(true, true, false, false),
    execute: (database) => createChannelModuleWithAudit(
      database as unknown as D1Database,
      actor,
      { channelId: "kanal-a", moduleId: "raid", enabled: true, settings: "{}" },
      "module.enabled",
      timestamp,
    ),
  },
  {
    name: "Change module settings",
    source: "db/channel-modules.ts:updateChannelModuleWithAudit + db/guards.ts:actorGuard",
    expected: allowed(true, true, false, false),
    execute: async (database) => {
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'raid', 1, '{}')`,
      ).run();
      return updateChannelModuleWithAudit(
        database as unknown as D1Database,
        actor,
        "kanal-a",
        "raid",
        true,
        '{"textSchwelle":5}',
        "raid.settings_changed",
        timestamp,
      );
    },
  },
  {
    name: "Toggle a single text command",
    source: "modules/text_commands/adapters/d1.ts:change + authorizeModuleMutation/actorGuard",
    expected: allowed(true, true, true, false),
    execute: async (database) => {
      await database.prepare(textCommandRow()).run();
      const result = await createTextCommandRepository(
        database as unknown as D1Database,
        authorizeModuleMutation,
      ).change({
        channelId: "kanal-a",
        name: "hallo",
        newName: "hallo",
        text: "Hallo {user}",
        kind: "text",
        enabled: false,
        onlyToggle: true,
        cooldownSeconds: 5,
        aliases: [],
        userCooldownSeconds: 0,
        streamCondition: "any",
        responseType: "say",
        now: timestamp,
      }, actor);
      return result.ok;
    },
  },
  {
    name: "Edit text command",
    source: "modules/text_commands/adapters/d1.ts:change + authorizeModuleManagementMutation/actorGuard",
    expected: allowed(true, true, false, false),
    execute: async (database) => {
      await database.prepare(textCommandRow()).run();
      const result = await createTextCommandRepository(
        database as unknown as D1Database,
        authorizeModuleManagementMutation,
      ).change({
        channelId: "kanal-a",
        name: "hallo",
        newName: "hallo-neu",
        text: "Neu",
        kind: "text",
        enabled: true,
        cooldownSeconds: 5,
        minimumTier: "everyone",
        aliases: [],
        userCooldownSeconds: 0,
        streamCondition: "any",
        responseType: "say",
        now: timestamp,
      }, actor);
      return result.ok;
    },
  },
  {
    name: "Create text command",
    source: "modules/text_commands/adapters/d1.ts:create + authorizeModuleManagementMutation/actorGuard",
    expected: allowed(true, true, false, false),
    execute: async (database) => {
      const result = await createTextCommandRepository(
        database as unknown as D1Database,
        authorizeModuleManagementMutation,
      ).create({
        channelId: "kanal-a",
        name: "neu",
        text: "Neu",
        kind: "text",
        cooldownSeconds: 5,
        now: timestamp,
      }, actor);
      return result.ok;
    },
  },
  {
    name: "Delete text command",
    source: "modules/text_commands/adapters/d1.ts:delete + authorizeModuleManagementMutation/actorGuard",
    expected: allowed(true, true, false, false),
    execute: async (database) => {
      await database.prepare(textCommandRow()).run();
      const result = await createTextCommandRepository(
        database as unknown as D1Database,
        authorizeModuleManagementMutation,
      ).delete("kanal-a", "hallo", actor, timestamp);
      return result.ok;
    },
  },
  {
    name: "Issue overlay token",
    source: "auth/overlay-token-repository.ts:createOverlayToken + actorGuard",
    expected: allowed(true, true, false, false),
    execute: (database) => createOverlayToken(
      database as unknown as D1Database,
      {
        tokenId: "token-1",
        channelId: "kanal-a",
        tokenHash: "hash-token-1",
        expiresAt: null,
        createdAt: timestamp,
        revokedAt: null,
        revocationReason: null,
        lastUsedAt: null,
      },
      actor,
    ),
  },
  {
    name: "Revoke overlay token",
    source: "auth/overlay-token-repository.ts:revokeOverlayToken + actorGuard",
    expected: allowed(true, true, false, false),
    execute: async (database) => {
      await database.prepare(overlayTokenRow("token-1")).run();
      return revokeOverlayToken(
        database as unknown as D1Database,
        "kanal-a",
        "token-1",
        "2026-09-18T00:01:00.000Z",
        "Test",
        actor,
      );
    },
  },
  {
    name: "Release operator channel",
    source: "platform/repository.ts:releasePlatformChannel + platformSessionGuard",
    expected: allowed(true, true, true, true),
    execute: (database) => releasePlatformChannel(
      database as unknown as D1Database,
      actor,
      { userId: "kanal-b", login: "kanal-b", displayName: "Kanal B" },
      true,
      timestamp,
    ),
  },
  {
    name: "Change operator full consent",
    source: "platform/repository.ts:changeFullConsent + platformSessionGuard",
    expected: allowed(true, true, true, true),
    execute: async (database) => {
      await insertChannel(database, "kanal-b");
      await database.prepare("UPDATE channels SET full_consent = 1 WHERE channel_id = 'kanal-b'").run();
      const channel: PlatformChannel = {
        channelId: "kanal-b",
        login: "kanal-b",
        displayName: "Kanal B",
        fullConsent: true,
      };
      return changeFullConsent(database as unknown as D1Database, actor, channel, false, timestamp);
    },
  },
  {
    name: "Create operator member",
    source: "platform/repository.ts:addPlatformMember + platformSessionGuard",
    expected: allowed(true, true, true, true),
    execute: async (database) => {
      await insertChannel(database, "kanal-b");
      return addPlatformMember(
        database as unknown as D1Database,
        actor,
        { channelId: "kanal-b", userId: "target", role: "manager", createdAt: timestamp, updatedAt: timestamp },
        timestamp,
      );
    },
  },
  {
    name: "Change operator member",
    source: "platform/repository.ts:changePlatformMember + platformSessionGuard",
    expected: allowed(true, true, true, true),
    execute: async (database) => {
      await insertChannel(database, "kanal-b");
      await database.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
         VALUES ('kanal-b', 'target', 'manager', ?, ?)`,
      ).bind(timestamp, timestamp).run();
      return changePlatformMember(
        database as unknown as D1Database,
        actor,
        { channelId: "kanal-b", userId: "target", role: "manager", createdAt: timestamp, updatedAt: timestamp },
        { channelId: "kanal-b", userId: "target", role: "operator", createdAt: timestamp, updatedAt: "2026-09-18T00:01:00.000Z" },
        "2026-09-18T00:01:00.000Z",
      );
    },
  },
  {
    name: "Remove operator member",
    source: "platform/repository.ts:removePlatformMember + platformSessionGuard",
    expected: allowed(true, true, true, true),
    execute: async (database) => {
      await insertChannel(database, "kanal-b");
      await database.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
         VALUES ('kanal-b', 'target', 'operator', ?, ?)`,
      ).bind(timestamp, timestamp).run();
      return removePlatformMember(
        database as unknown as D1Database,
        actor,
        { channelId: "kanal-b", userId: "target", role: "operator", createdAt: timestamp, updatedAt: timestamp },
        "2026-09-18T00:01:00.000Z",
      );
    },
  },
];

const setupActor = async (database: TestD1Database, role: RoleRow): Promise<void> => {
  await insertChannel(database, "kanal-a");
  await insertLoginIdentityAndSession(database, "actor");
  if (role !== "no member") await insertMember(database, "kanal-a", "actor", role);
};

describe("Role-times-action matrix", () => {
  it("runs every guard-protected write action for every channel role", async () => {
    // Without this floor, the test would pass if the table ran empty.
    expect(actions.length).toBeGreaterThanOrEqual(20);
    for (const action of actions) {
      for (const row of roleRows) {
        const database = new TestD1Database();
        try {
          await setupActor(database, row);
          const actual = await action.execute(database, row === "no member" ? null : row);
          expect(actual, `${action.name} (${row}) — ${action.source}`).toBe(action.expected[row]);
        } finally {
          database.close();
        }
      }
    }
  });
});
