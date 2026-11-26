import { describe, expect, it } from "vitest";

import {
  discordMemberRoleStatus,
  discordRoleShouldBeRemoved,
  desiredDiscordRoleGrants,
  previewDiscordRoleChanges,
  type DiscordGrantRecord,
  type DiscordLinkRecord,
} from "../../src/modules/discord/reconcile-domain";

const link = (discordUserId: string, twitchUserId: string, twitchLogin: string): DiscordLinkRecord => ({
  discordUserId,
  twitchUserId,
  twitchLogin,
});

const grant = (overrides: Partial<DiscordGrantRecord> = {}): DiscordGrantRecord => ({
  guildId: "990000000000000101",
  discordUserId: "990000000000000201",
  twitchUserId: "990000000000000301",
  roleId: "990000000000000102",
  joinedAt: "2026-11-01T10:00:00.000Z",
  grantedAt: 1_000,
  status: "granted",
  ...overrides,
});

describe("Discord rank role reconciliation rules", () => {
  it("deduplicates a role shared by VIP and moderator mappings", () => {
    const grants = desiredDiscordRoleGrants(
      { vip: "role-shared", moderator: "role-shared" },
      { vip: new Set(["twitch-vip"]), moderator: new Set(["twitch-mod"]) },
      [link("discord-vip", "twitch-vip", "pixelpilot"), link("discord-mod", "twitch-mod", "harborwatch")],
    );

    expect(grants).toEqual([
      { discordUserId: "discord-mod", twitchUserId: "twitch-mod", twitchLogin: "harborwatch", roleId: "role-shared" },
      { discordUserId: "discord-vip", twitchUserId: "twitch-vip", twitchLogin: "pixelpilot", roleId: "role-shared" },
    ]);
  });

  it("keeps a mapped role while any rank mapped to it is incomplete", () => {
    expect(discordRoleShouldBeRemoved(grant(), link("990000000000000201", "990000000000000301", "pixelpilot"), {
      vip: "990000000000000102",
      moderator: "990000000000000102",
    }, {
      vip: { complete: true, userIds: new Set() },
      moderator: { complete: false, userIds: new Set() },
    })).toBe(false);
  });

  it("removes a rank-lost role only when every mapping for it is complete", () => {
    const existing = grant();
    const currentLink = link(existing.discordUserId, existing.twitchUserId, "pixelpilot");
    const mappings = { vip: existing.roleId, moderator: existing.roleId };

    expect(discordRoleShouldBeRemoved(existing, currentLink, mappings, {
      vip: { complete: true, userIds: new Set() },
      moderator: { complete: true, userIds: new Set() },
    })).toBe(true);
    expect(discordRoleShouldBeRemoved(existing, currentLink, mappings, {
      vip: { complete: true, userIds: new Set([existing.twitchUserId]) },
      moderator: { complete: true, userIds: new Set() },
    })).toBe(false);
  });

  it("removes on unlink or a replaced Twitch identity without waiting for rank completeness", () => {
    const existing = grant();
    const mappings = { vip: existing.roleId, moderator: null };

    expect(discordRoleShouldBeRemoved(existing, null, mappings, {
      vip: { complete: false, userIds: new Set() },
      moderator: { complete: false, userIds: new Set() },
    })).toBe(true);
    expect(discordRoleShouldBeRemoved(existing, link(existing.discordUserId, "different-twitch", "newlink"), mappings, {
      vip: { complete: false, userIds: new Set() },
      moderator: { complete: false, userIds: new Set() },
    })).toBe(true);
  });

  it("reports pending and not-in-server states before the regular no-rank fallback", () => {
    expect(discordMemberRoleStatus({
      locked: false,
      desired: false,
      rankKnown: true,
      grantStatus: "pending",
      notInServer: true,
    })).toBe("pending");
    expect(discordMemberRoleStatus({
      locked: false,
      desired: false,
      rankKnown: true,
      grantStatus: null,
      notInServer: true,
    })).toBe("not_in_server");
    expect(discordMemberRoleStatus({
      locked: false,
      desired: false,
      rankKnown: true,
      grantStatus: null,
      notInServer: false,
    })).toBe("no_rank");
    expect(discordMemberRoleStatus({
      locked: false,
      desired: false,
      rankKnown: false,
      grantStatus: null,
      notInServer: false,
    })).toBe("unknown");
  });

  it("uses the latest member read after a role write or removal for the public status", () => {
    expect(discordMemberRoleStatus({
      locked: false,
      desired: true,
      rankKnown: true,
      grantStatus: "granted",
      notInServer: false,
      observedHasRole: true,
    })).toBe("has_role");
    expect(discordMemberRoleStatus({
      locked: false,
      desired: false,
      rankKnown: true,
      grantStatus: null,
      notInServer: false,
      observedHasRole: false,
    })).toBe("no_rank");
  });

  it("counts additions and removals by distinct linked Discord account and role", () => {
    const counts = previewDiscordRoleChanges({
      mappings: { vip: "role-new", moderator: null },
      rankUsers: { vip: new Set(["twitch-vip"]), moderator: new Set() },
      links: [link("discord-vip", "twitch-vip", "pixelpilot")],
      ledger: [grant({ discordUserId: "discord-old", roleId: "role-old" })],
      roleNames: new Map([["role-new", "Harbor VIP"], ["role-old", "Harbor Crew"]]),
    });

    expect(counts).toEqual({
      gain: { count: 1, roleName: "Harbor VIP" },
      lose: [{ count: 1, roleName: "Harbor Crew" }],
    });
  });
});
