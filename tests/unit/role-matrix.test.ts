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
type Zeile = ChannelRole | "kein Mitglied";

const rollen: readonly Zeile[] = ["broadcaster", "manager", "operator", "kein Mitglied"];
const timestamp = "2026-09-18T00:00:00.000Z";
const actor: ActorContext = { userId: "actor", sessionId: "session-actor" };

const allowed = (
  broadcaster: boolean,
  verwalter: boolean,
  bediener: boolean,
  noMember: boolean,
): Record<Zeile, boolean> => ({
  broadcaster,
  manager: verwalter,
  operator: bediener,
  "kein Mitglied": noMember,
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

interface Rollenaktion {
  name: string;
  source: string;
  erwartet: Record<Zeile, boolean>;
  ausführen: (database: TestD1Database, role: ChannelRole | null) => Promise<boolean>;
}

const aktionen: readonly Rollenaktion[] = [
  {
    name: "Kanalmitglied als Bediener anlegen",
    source: "db/channel-members.ts:createChannelMemberWithAudit + db/guards.ts:actorGuard(requiredActorRoles)",
    erwartet: allowed(true, true, false, false),
    ausführen: (database) => createChannelMemberWithAudit(
      database as unknown as D1Database,
      actor,
      actionMember("target", "operator"),
      "mitglied.hinzugefügt",
      timestamp,
      actorGuard(requiredActorRoles("operator")),
    ),
  },
  {
    name: "Kanalmitglied als Broadcaster anlegen",
    source: "db/channel-members.ts:createChannelMemberWithAudit + db/guards.ts:actorGuard(requiredActorRoles)",
    erwartet: allowed(true, false, false, false),
    ausführen: (database) => createChannelMemberWithAudit(
      database as unknown as D1Database,
      actor,
      actionMember("target", "broadcaster"),
      "mitglied.hinzugefügt",
      timestamp,
      actorGuard(requiredActorRoles("broadcaster")),
    ),
  },
  {
    name: "Kanalmitglied von Bediener zu Verwalter ändern",
    source: "db/channel-members.ts:updateChannelMemberWithAudit + db/guards.ts:actorGuard(requiredActorRoles)",
    erwartet: allowed(true, true, false, false),
    ausführen: async (database) => {
      await insertMember(database, "kanal-a", "target", "operator");
      return updateChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        actionMember("target", "manager"),
        "mitglied.rolle_geändert",
        timestamp,
        actorGuard(requiredActorRoles("manager", "operator")),
      );
    },
  },
  {
    name: "Kanalmitglied von Broadcaster zu Verwalter ändern",
    source: "db/channel-members.ts:updateChannelMemberWithAudit + db/guards.ts:lastBroadcasterRoleChangeGuard",
    erwartet: allowed(true, false, false, false),
    ausführen: async (database) => {
      await insertMember(database, "kanal-a", "target", "broadcaster");
      const member = actionMember("target", "manager");
      return updateChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        member,
        "mitglied.rolle_geändert",
        timestamp,
        actorGuard(requiredActorRoles(member.role, "broadcaster")),
      );
    },
  },
  {
    name: "Letzten Broadcaster herabstufen",
    source: "db/channel-members.ts:updateChannelMemberWithAudit + db/guards.ts:lastBroadcasterRoleChangeGuard",
    erwartet: allowed(false, false, false, false),
    ausführen: async (database, role) => {
      const target = role === "broadcaster" ? "actor" : "target";
      if (target === "actor") {
        return updateChannelMemberWithAudit(
          database as unknown as D1Database,
          actor,
          actionMember("actor", "manager"),
          "mitglied.rolle_geändert",
          timestamp,
          actorGuard(requiredActorRoles("manager", "broadcaster")),
        );
      }
      await insertMember(database, "kanal-a", target, "broadcaster");
      return updateChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        actionMember(target, "manager"),
        "mitglied.rolle_geändert",
        timestamp,
        actorGuard(requiredActorRoles("manager", "broadcaster")),
      );
    },
  },
  {
    name: "Kanalmitglied als Bediener entfernen",
    source: "db/channel-members.ts:deleteChannelMemberWithAudit + db/guards.ts:actorGuard + db/guards.ts:lastBroadcasterGuard",
    erwartet: allowed(true, true, false, false),
    ausführen: async (database) => {
      await insertMember(database, "kanal-a", "target", "operator");
      return deleteChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        "kanal-a",
        "target",
        "mitglied.entfernt",
        timestamp,
        actorGuard(requiredActorRoles(undefined, "operator")),
      );
    },
  },
  {
    name: "Nicht letzten Broadcaster entfernen",
    source: "db/channel-members.ts:deleteChannelMemberWithAudit + db/guards.ts:lastBroadcasterGuard",
    erwartet: allowed(true, false, false, false),
    ausführen: async (database) => {
      await insertMember(database, "kanal-a", "target", "broadcaster");
      return deleteChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        "kanal-a",
        "target",
        "mitglied.entfernt",
        timestamp,
        actorGuard(requiredActorRoles(undefined, "broadcaster")),
      );
    },
  },
  {
    name: "Letzten Broadcaster entfernen",
    source: "db/channel-members.ts:deleteChannelMemberWithAudit + db/guards.ts:lastBroadcasterGuard",
    erwartet: allowed(false, false, false, false),
    ausführen: async (database, role) => {
      const target = role === "broadcaster" ? "actor" : "target";
      if (target !== "actor") await insertMember(database, "kanal-a", target, "broadcaster");
      return deleteChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        "kanal-a",
        target,
        "mitglied.entfernt",
        timestamp,
        actorGuard(requiredActorRoles(undefined, "broadcaster")),
      );
    },
  },
  {
    name: "Modul aktivieren",
    source: "db/channel-modules.ts:createChannelModuleWithAudit + db/guards.ts:actorGuard",
    erwartet: allowed(true, true, false, false),
    ausführen: (database) => createChannelModuleWithAudit(
      database as unknown as D1Database,
      actor,
      { channelId: "kanal-a", moduleId: "raid", enabled: true, settings: "{}" },
      "modul.aktiviert",
      timestamp,
    ),
  },
  {
    name: "Moduleinstellungen ändern",
    source: "db/channel-modules.ts:updateChannelModuleWithAudit + db/guards.ts:actorGuard",
    erwartet: allowed(true, true, false, false),
    ausführen: async (database) => {
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
        "raid.einstellungen_geaendert",
        timestamp,
      );
    },
  },
  {
    name: "Einzelnen Textbefehl schalten",
    source: "modules/textbefehle/adapters/d1.ts:aendern + authorizeModuleMutation/actorGuard",
    erwartet: allowed(true, true, true, false),
    ausführen: async (database) => {
      await database.prepare(textCommandRow()).run();
      const result = await createTextCommandRepository(
        database as unknown as D1Database,
        authorizeModuleMutation,
      ).aendern({
        channelId: "kanal-a",
        name: "hallo",
        neuerName: "hallo",
        text: "Hallo {user}",
        kind: "text",
        enabled: false,
        nurSchalter: true,
        cooldownSeconds: 5,
        now: timestamp,
      }, actor);
      return result.ok;
    },
  },
  {
    name: "Textbefehl bearbeiten",
    source: "modules/textbefehle/adapters/d1.ts:aendern + authorizeModuleManagementMutation/actorGuard",
    erwartet: allowed(true, true, false, false),
    ausführen: async (database) => {
      await database.prepare(textCommandRow()).run();
      const result = await createTextCommandRepository(
        database as unknown as D1Database,
        authorizeModuleManagementMutation,
      ).aendern({
        channelId: "kanal-a",
        name: "hallo",
        neuerName: "hallo-neu",
        text: "Neu",
        kind: "text",
        enabled: true,
        cooldownSeconds: 5,
        minimumTier: "everyone",
        now: timestamp,
      }, actor);
      return result.ok;
    },
  },
  {
    name: "Textbefehl anlegen",
    source: "modules/textbefehle/adapters/d1.ts:anlegen + authorizeModuleManagementMutation/actorGuard",
    erwartet: allowed(true, true, false, false),
    ausführen: async (database) => {
      const result = await createTextCommandRepository(
        database as unknown as D1Database,
        authorizeModuleManagementMutation,
      ).anlegen({
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
    name: "Textbefehl löschen",
    source: "modules/textbefehle/adapters/d1.ts:loeschen + authorizeModuleManagementMutation/actorGuard",
    erwartet: allowed(true, true, false, false),
    ausführen: async (database) => {
      await database.prepare(textCommandRow()).run();
      const result = await createTextCommandRepository(
        database as unknown as D1Database,
        authorizeModuleManagementMutation,
      ).loeschen("kanal-a", "hallo", actor, timestamp);
      return result.ok;
    },
  },
  {
    name: "Overlay-Token ausstellen",
    source: "auth/overlay-token-repository.ts:createOverlayToken + actorGuard",
    erwartet: allowed(true, true, false, false),
    ausführen: (database) => createOverlayToken(
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
    name: "Overlay-Token widerrufen",
    source: "auth/overlay-token-repository.ts:revokeOverlayToken + actorGuard",
    erwartet: allowed(true, true, false, false),
    ausführen: async (database) => {
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
    name: "Betreiber-Kanal freigeben",
    source: "platform/repository.ts:releasePlatformChannel + platformSessionGuard",
    erwartet: allowed(true, true, true, true),
    ausführen: (database) => releasePlatformChannel(
      database as unknown as D1Database,
      actor,
      { userId: "kanal-b", login: "kanal-b", displayName: "Kanal B" },
      true,
      timestamp,
    ),
  },
  {
    name: "Betreiber-Vollzustimmung ändern",
    source: "platform/repository.ts:changeFullConsent + platformSessionGuard",
    erwartet: allowed(true, true, true, true),
    ausführen: async (database) => {
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
    name: "Betreiber-Mitglied anlegen",
    source: "platform/repository.ts:addPlatformMember + platformSessionGuard",
    erwartet: allowed(true, true, true, true),
    ausführen: async (database) => {
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
    name: "Betreiber-Mitglied ändern",
    source: "platform/repository.ts:changePlatformMember + platformSessionGuard",
    erwartet: allowed(true, true, true, true),
    ausführen: async (database) => {
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
    name: "Betreiber-Mitglied entfernen",
    source: "platform/repository.ts:removePlatformMember + platformSessionGuard",
    erwartet: allowed(true, true, true, true),
    ausführen: async (database) => {
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

const setupActor = async (database: TestD1Database, role: Zeile): Promise<void> => {
  await insertChannel(database, "kanal-a");
  await insertLoginIdentityAndSession(database, "actor");
  if (role !== "kein Mitglied") await insertMember(database, "kanal-a", "actor", role);
};

describe("Rollen-mal-Aktion-Matrix", () => {
  it("führt jede Guard-geschützte Schreibaktion für jede Kanalrolle aus", async () => {
    // Ohne diese Schranke waere der Test gruen, wenn die Tabelle leer liefe.
    expect(aktionen.length).toBeGreaterThanOrEqual(20);
    for (const action of aktionen) {
      for (const row of rollen) {
        const database = new TestD1Database();
        try {
          await setupActor(database, row);
          const actual = await action.ausführen(database, row === "kein Mitglied" ? null : row);
          expect(actual, `${action.name} (${row}) — ${action.source}`).toBe(action.erwartet[row]);
        } finally {
          database.close();
        }
      }
    }
  });
});
