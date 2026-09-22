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
import { createTextbefehlRepository } from "../../src/modules/textbefehle/adapters/d1";
import {
  ändereBetreiberMitglied,
  ändereVollzustimmung,
  entferneBetreiberMitglied,
  freigebenBetreiberKanal,
  fügeBetreiberMitgliedHinzu,
  type BetreiberKanal,
} from "../../src/worker/betreiber/repository";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

type Kanalrolle = "broadcaster" | "verwalter" | "bediener";
type Zeile = Kanalrolle | "kein Mitglied";

const rollen: readonly Zeile[] = ["broadcaster", "verwalter", "bediener", "kein Mitglied"];
const zeitpunkt = "2026-09-18T00:00:00.000Z";
const akteur: ActorContext = { userId: "actor", sessionId: "session-actor" };

const erlaubt = (
  broadcaster: boolean,
  verwalter: boolean,
  bediener: boolean,
  keinMitglied: boolean,
): Record<Zeile, boolean> => ({
  broadcaster,
  verwalter,
  bediener,
  "kein Mitglied": keinMitglied,
});

const aktionsMitglied = (
  userId: string,
  role: Kanalrolle,
  createdAt = zeitpunkt,
  updatedAt = zeitpunkt,
): ChannelMemberRecord => ({
  channelId: "kanal-a",
  userId,
  role,
  createdAt,
  updatedAt,
});

const textbefehlZeile = (name = "hallo", enabled = true): string =>
  `INSERT INTO textbefehle_commands
    (channel_id, command_name, response_text, art, enabled, minimum_level, cooldown_seconds, last_used_at, created_at, updated_at)
   VALUES ('kanal-a', '${name}', 'Hallo {user}', 'text', ${enabled ? "1" : "0"}, 'alle', 5, NULL, '${zeitpunkt}', '${zeitpunkt}')`;

const overlayTokenZeile = (tokenId: string): string =>
  `INSERT INTO overlay_tokens
    (token_id, channel_id, token_hash, expires_at, created_at, revoked_at, revocation_reason, last_used_at)
   VALUES ('${tokenId}', 'kanal-a', 'hash-${tokenId}', NULL, '${zeitpunkt}', NULL, NULL, NULL)`;

interface Rollenaktion {
  name: string;
  quelle: string;
  erwartet: Record<Zeile, boolean>;
  ausführen: (database: TestD1Database, role: Kanalrolle | null) => Promise<boolean>;
}

const aktionen: readonly Rollenaktion[] = [
  {
    name: "Kanalmitglied als Bediener anlegen",
    quelle: "db/channel-members.ts:createChannelMemberWithAudit + db/guards.ts:actorGuard(requiredActorRoles)",
    erwartet: erlaubt(true, true, false, false),
    ausführen: (database) => createChannelMemberWithAudit(
      database as unknown as D1Database,
      akteur,
      aktionsMitglied("target", "bediener"),
      "mitglied.hinzugefügt",
      zeitpunkt,
      actorGuard(requiredActorRoles("bediener")),
    ),
  },
  {
    name: "Kanalmitglied als Broadcaster anlegen",
    quelle: "db/channel-members.ts:createChannelMemberWithAudit + db/guards.ts:actorGuard(requiredActorRoles)",
    erwartet: erlaubt(true, false, false, false),
    ausführen: (database) => createChannelMemberWithAudit(
      database as unknown as D1Database,
      akteur,
      aktionsMitglied("target", "broadcaster"),
      "mitglied.hinzugefügt",
      zeitpunkt,
      actorGuard(requiredActorRoles("broadcaster")),
    ),
  },
  {
    name: "Kanalmitglied von Bediener zu Verwalter ändern",
    quelle: "db/channel-members.ts:updateChannelMemberWithAudit + db/guards.ts:actorGuard(requiredActorRoles)",
    erwartet: erlaubt(true, true, false, false),
    ausführen: async (database) => {
      await insertMember(database, "kanal-a", "target", "bediener");
      return updateChannelMemberWithAudit(
        database as unknown as D1Database,
        akteur,
        aktionsMitglied("target", "verwalter"),
        "mitglied.rolle_geändert",
        zeitpunkt,
        actorGuard(requiredActorRoles("verwalter", "bediener")),
      );
    },
  },
  {
    name: "Kanalmitglied von Broadcaster zu Verwalter ändern",
    quelle: "db/channel-members.ts:updateChannelMemberWithAudit + db/guards.ts:lastBroadcasterRoleChangeGuard",
    erwartet: erlaubt(true, false, false, false),
    ausführen: async (database) => {
      await insertMember(database, "kanal-a", "target", "broadcaster");
      const member = aktionsMitglied("target", "verwalter");
      return updateChannelMemberWithAudit(
        database as unknown as D1Database,
        akteur,
        member,
        "mitglied.rolle_geändert",
        zeitpunkt,
        actorGuard(requiredActorRoles(member.role, "broadcaster")),
      );
    },
  },
  {
    name: "Letzten Broadcaster herabstufen",
    quelle: "db/channel-members.ts:updateChannelMemberWithAudit + db/guards.ts:lastBroadcasterRoleChangeGuard",
    erwartet: erlaubt(false, false, false, false),
    ausführen: async (database, role) => {
      const target = role === "broadcaster" ? "actor" : "target";
      if (target === "actor") {
        return updateChannelMemberWithAudit(
          database as unknown as D1Database,
          akteur,
          aktionsMitglied("actor", "verwalter"),
          "mitglied.rolle_geändert",
          zeitpunkt,
          actorGuard(requiredActorRoles("verwalter", "broadcaster")),
        );
      }
      await insertMember(database, "kanal-a", target, "broadcaster");
      return updateChannelMemberWithAudit(
        database as unknown as D1Database,
        akteur,
        aktionsMitglied(target, "verwalter"),
        "mitglied.rolle_geändert",
        zeitpunkt,
        actorGuard(requiredActorRoles("verwalter", "broadcaster")),
      );
    },
  },
  {
    name: "Kanalmitglied als Bediener entfernen",
    quelle: "db/channel-members.ts:deleteChannelMemberWithAudit + db/guards.ts:actorGuard + db/guards.ts:lastBroadcasterGuard",
    erwartet: erlaubt(true, true, false, false),
    ausführen: async (database) => {
      await insertMember(database, "kanal-a", "target", "bediener");
      return deleteChannelMemberWithAudit(
        database as unknown as D1Database,
        akteur,
        "kanal-a",
        "target",
        "mitglied.entfernt",
        zeitpunkt,
        actorGuard(requiredActorRoles(undefined, "bediener")),
      );
    },
  },
  {
    name: "Nicht letzten Broadcaster entfernen",
    quelle: "db/channel-members.ts:deleteChannelMemberWithAudit + db/guards.ts:lastBroadcasterGuard",
    erwartet: erlaubt(true, false, false, false),
    ausführen: async (database) => {
      await insertMember(database, "kanal-a", "target", "broadcaster");
      return deleteChannelMemberWithAudit(
        database as unknown as D1Database,
        akteur,
        "kanal-a",
        "target",
        "mitglied.entfernt",
        zeitpunkt,
        actorGuard(requiredActorRoles(undefined, "broadcaster")),
      );
    },
  },
  {
    name: "Letzten Broadcaster entfernen",
    quelle: "db/channel-members.ts:deleteChannelMemberWithAudit + db/guards.ts:lastBroadcasterGuard",
    erwartet: erlaubt(false, false, false, false),
    ausführen: async (database, role) => {
      const target = role === "broadcaster" ? "actor" : "target";
      if (target !== "actor") await insertMember(database, "kanal-a", target, "broadcaster");
      return deleteChannelMemberWithAudit(
        database as unknown as D1Database,
        akteur,
        "kanal-a",
        target,
        "mitglied.entfernt",
        zeitpunkt,
        actorGuard(requiredActorRoles(undefined, "broadcaster")),
      );
    },
  },
  {
    name: "Modul aktivieren",
    quelle: "db/channel-modules.ts:createChannelModuleWithAudit + db/guards.ts:actorGuard",
    erwartet: erlaubt(true, true, false, false),
    ausführen: (database) => createChannelModuleWithAudit(
      database as unknown as D1Database,
      akteur,
      { channelId: "kanal-a", moduleId: "raid", enabled: true, settings: "{}" },
      "modul.aktiviert",
      zeitpunkt,
    ),
  },
  {
    name: "Moduleinstellungen ändern",
    quelle: "db/channel-modules.ts:updateChannelModuleWithAudit + db/guards.ts:actorGuard",
    erwartet: erlaubt(true, true, false, false),
    ausführen: async (database) => {
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'raid', 1, '{}')`,
      ).run();
      return updateChannelModuleWithAudit(
        database as unknown as D1Database,
        akteur,
        "kanal-a",
        "raid",
        true,
        '{"textSchwelle":5}',
        "raid.einstellungen_geaendert",
        zeitpunkt,
      );
    },
  },
  {
    name: "Einzelnen Textbefehl schalten",
    quelle: "modules/textbefehle/adapters/d1.ts:aendern + authorizeModuleMutation/actorGuard",
    erwartet: erlaubt(true, true, true, false),
    ausführen: async (database) => {
      await database.prepare(textbefehlZeile()).run();
      const result = await createTextbefehlRepository(
        database as unknown as D1Database,
        authorizeModuleMutation,
      ).aendern({
        channelId: "kanal-a",
        name: "hallo",
        neuerName: "hallo",
        text: "Hallo {user}",
        art: "text",
        enabled: false,
        nurSchalter: true,
        cooldownSekunden: 5,
        now: zeitpunkt,
      }, akteur);
      return result.ok;
    },
  },
  {
    name: "Textbefehl bearbeiten",
    quelle: "modules/textbefehle/adapters/d1.ts:aendern + authorizeModuleManagementMutation/actorGuard",
    erwartet: erlaubt(true, true, false, false),
    ausführen: async (database) => {
      await database.prepare(textbefehlZeile()).run();
      const result = await createTextbefehlRepository(
        database as unknown as D1Database,
        authorizeModuleManagementMutation,
      ).aendern({
        channelId: "kanal-a",
        name: "hallo",
        neuerName: "hallo-neu",
        text: "Neu",
        art: "text",
        enabled: true,
        cooldownSekunden: 5,
        mindeststufe: "alle",
        now: zeitpunkt,
      }, akteur);
      return result.ok;
    },
  },
  {
    name: "Textbefehl anlegen",
    quelle: "modules/textbefehle/adapters/d1.ts:anlegen + authorizeModuleManagementMutation/actorGuard",
    erwartet: erlaubt(true, true, false, false),
    ausführen: async (database) => {
      const result = await createTextbefehlRepository(
        database as unknown as D1Database,
        authorizeModuleManagementMutation,
      ).anlegen({
        channelId: "kanal-a",
        name: "neu",
        text: "Neu",
        art: "text",
        cooldownSekunden: 5,
        now: zeitpunkt,
      }, akteur);
      return result.ok;
    },
  },
  {
    name: "Textbefehl löschen",
    quelle: "modules/textbefehle/adapters/d1.ts:loeschen + authorizeModuleManagementMutation/actorGuard",
    erwartet: erlaubt(true, true, false, false),
    ausführen: async (database) => {
      await database.prepare(textbefehlZeile()).run();
      const result = await createTextbefehlRepository(
        database as unknown as D1Database,
        authorizeModuleManagementMutation,
      ).loeschen("kanal-a", "hallo", akteur, zeitpunkt);
      return result.ok;
    },
  },
  {
    name: "Overlay-Token ausstellen",
    quelle: "auth/overlay-token-repository.ts:createOverlayToken + actorGuard",
    erwartet: erlaubt(true, true, false, false),
    ausführen: (database) => createOverlayToken(
      database as unknown as D1Database,
      {
        tokenId: "token-1",
        channelId: "kanal-a",
        tokenHash: "hash-token-1",
        expiresAt: null,
        createdAt: zeitpunkt,
        revokedAt: null,
        revocationReason: null,
        lastUsedAt: null,
      },
      akteur,
    ),
  },
  {
    name: "Overlay-Token widerrufen",
    quelle: "auth/overlay-token-repository.ts:revokeOverlayToken + actorGuard",
    erwartet: erlaubt(true, true, false, false),
    ausführen: async (database) => {
      await database.prepare(overlayTokenZeile("token-1")).run();
      return revokeOverlayToken(
        database as unknown as D1Database,
        "kanal-a",
        "token-1",
        "2026-09-18T00:01:00.000Z",
        "Test",
        akteur,
      );
    },
  },
  {
    name: "Betreiber-Kanal freigeben",
    quelle: "betreiber/repository.ts:freigebenBetreiberKanal + betreiberSessionGuard",
    erwartet: erlaubt(true, true, true, true),
    ausführen: (database) => freigebenBetreiberKanal(
      database as unknown as D1Database,
      akteur,
      { userId: "kanal-b", login: "kanal-b", displayName: "Kanal B" },
      true,
      zeitpunkt,
    ),
  },
  {
    name: "Betreiber-Vollzustimmung ändern",
    quelle: "betreiber/repository.ts:ändereVollzustimmung + betreiberSessionGuard",
    erwartet: erlaubt(true, true, true, true),
    ausführen: async (database) => {
      await insertChannel(database, "kanal-b");
      await database.prepare("UPDATE channels SET vollzustimmung = 1 WHERE channel_id = 'kanal-b'").run();
      const channel: BetreiberKanal = {
        channelId: "kanal-b",
        login: "kanal-b",
        displayName: "Kanal B",
        vollzustimmung: true,
      };
      return ändereVollzustimmung(database as unknown as D1Database, akteur, channel, false, zeitpunkt);
    },
  },
  {
    name: "Betreiber-Mitglied anlegen",
    quelle: "betreiber/repository.ts:fügeBetreiberMitgliedHinzu + betreiberSessionGuard",
    erwartet: erlaubt(true, true, true, true),
    ausführen: async (database) => {
      await insertChannel(database, "kanal-b");
      return fügeBetreiberMitgliedHinzu(
        database as unknown as D1Database,
        akteur,
        { channelId: "kanal-b", userId: "target", role: "verwalter", createdAt: zeitpunkt, updatedAt: zeitpunkt },
        zeitpunkt,
      );
    },
  },
  {
    name: "Betreiber-Mitglied ändern",
    quelle: "betreiber/repository.ts:ändereBetreiberMitglied + betreiberSessionGuard",
    erwartet: erlaubt(true, true, true, true),
    ausführen: async (database) => {
      await insertChannel(database, "kanal-b");
      await database.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
         VALUES ('kanal-b', 'target', 'verwalter', ?, ?)`,
      ).bind(zeitpunkt, zeitpunkt).run();
      return ändereBetreiberMitglied(
        database as unknown as D1Database,
        akteur,
        { channelId: "kanal-b", userId: "target", role: "verwalter", createdAt: zeitpunkt, updatedAt: zeitpunkt },
        { channelId: "kanal-b", userId: "target", role: "bediener", createdAt: zeitpunkt, updatedAt: "2026-09-18T00:01:00.000Z" },
        "2026-09-18T00:01:00.000Z",
      );
    },
  },
  {
    name: "Betreiber-Mitglied entfernen",
    quelle: "betreiber/repository.ts:entferneBetreiberMitglied + betreiberSessionGuard",
    erwartet: erlaubt(true, true, true, true),
    ausführen: async (database) => {
      await insertChannel(database, "kanal-b");
      await database.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
         VALUES ('kanal-b', 'target', 'bediener', ?, ?)`,
      ).bind(zeitpunkt, zeitpunkt).run();
      return entferneBetreiberMitglied(
        database as unknown as D1Database,
        akteur,
        { channelId: "kanal-b", userId: "target", role: "bediener", createdAt: zeitpunkt, updatedAt: zeitpunkt },
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
          expect(actual, `${action.name} (${row}) — ${action.quelle}`).toBe(action.erwartet[row]);
        } finally {
          database.close();
        }
      }
    }
  });
});
