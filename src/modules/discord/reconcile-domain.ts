import type { DiscordRoleMappings } from "./contracts";

export interface DiscordLinkRecord {
  discordUserId: string;
  twitchUserId: string;
  twitchLogin: string;
}

export interface DiscordGrantRecord extends Record<string, string | number | null> {
  guildId: string;
  discordUserId: string;
  /** The link identity that caused BroBot to add this role. */
  twitchUserId: string;
  roleId: string;
  joinedAt: string;
  grantedAt: number | null;
  status: "pending" | "granted";
}

export interface DiscordDesiredRoleGrant {
  discordUserId: string;
  twitchUserId: string;
  twitchLogin: string;
  roleId: string;
}

export interface DiscordRankMembership {
  complete: boolean;
  userIds: ReadonlySet<string>;
}

export const desiredDiscordRoleGrants = (
  mappings: DiscordRoleMappings,
  rankUserIds: Readonly<Record<"vip" | "moderator", ReadonlySet<string>>>,
  links: readonly DiscordLinkRecord[],
): DiscordDesiredRoleGrant[] => {
  const result = new Map<string, DiscordDesiredRoleGrant>();
  for (const link of links) {
    for (const rankType of ["vip", "moderator"] as const) {
      const roleId = mappings[rankType];
      if (roleId === null || !rankUserIds[rankType].has(link.twitchUserId)) continue;
      result.set(`${link.discordUserId}:${roleId}`, {
        discordUserId: link.discordUserId,
        twitchUserId: link.twitchUserId,
        twitchLogin: link.twitchLogin,
        roleId,
      });
    }
  }
  return [...result.values()].sort((left, right) =>
    left.discordUserId.localeCompare(right.discordUserId) || left.roleId.localeCompare(right.roleId));
};

export const discordRoleShouldBeRemoved = (
  grant: Pick<DiscordGrantRecord, "discordUserId" | "twitchUserId" | "roleId">,
  currentLink: DiscordLinkRecord | null,
  mappings: DiscordRoleMappings,
  ranks: Readonly<Record<"vip" | "moderator", DiscordRankMembership>>,
): boolean => {
  if (currentLink === null || currentLink.discordUserId !== grant.discordUserId ||
      currentLink.twitchUserId !== grant.twitchUserId) return true;
  const mappedRanks = (["vip", "moderator"] as const).filter((rankType) => mappings[rankType] === grant.roleId);
  if (mappedRanks.length === 0) return true;
  return mappedRanks.every((rankType) => ranks[rankType].complete && !ranks[rankType].userIds.has(currentLink.twitchUserId));
};

export type DiscordLinkedMemberRoleStatus = "has_role" | "pending" | "not_in_server" | "no_rank" | "locked" | "unknown";

export const discordMemberRoleStatus = (input: {
  locked: boolean;
  desired: boolean;
  rankKnown: boolean;
  grantStatus: "pending" | "granted" | null;
  notInServer: boolean;
  observedHasRole?: boolean | null;
}): DiscordLinkedMemberRoleStatus => {
  if (input.locked) return "locked";
  if (input.grantStatus === "pending" && input.observedHasRole !== true) return "pending";
  if (input.notInServer) return "not_in_server";
  if (input.observedHasRole === true) return "has_role";
  if (!input.rankKnown) return "unknown";
  if (input.grantStatus === "granted" && input.observedHasRole !== false) return "has_role";
  return input.desired ? "pending" : "no_rank";
};

export const previewDiscordRoleChanges = (input: {
  mappings: DiscordRoleMappings;
  rankUsers: Readonly<Record<"vip" | "moderator", ReadonlySet<string>>>;
  links: readonly DiscordLinkRecord[];
  ledger: readonly DiscordGrantRecord[];
  roleNames: ReadonlyMap<string, string>;
}): { gain: { count: number; roleName: string }; lose: Array<{ count: number; roleName: string }> } => {
  const desired = desiredDiscordRoleGrants(input.mappings, input.rankUsers, input.links);
  const desiredKeys = new Set(desired.map(({ discordUserId, roleId }) => `${discordUserId}:${roleId}`));
  const existingKeys = new Set(input.ledger.map(({ discordUserId, roleId }) => `${discordUserId}:${roleId}`));
  const gains = desired.filter(({ discordUserId, roleId }) => !existingKeys.has(`${discordUserId}:${roleId}`));
  const lossesByRole = new Map<string, Set<string>>();
  for (const grant of input.ledger) {
    if (desiredKeys.has(`${grant.discordUserId}:${grant.roleId}`)) continue;
    const people = lossesByRole.get(grant.roleId) ?? new Set<string>();
    people.add(grant.discordUserId);
    lossesByRole.set(grant.roleId, people);
  }
  const roleName = (roleId: string): string => input.roleNames.get(roleId) ?? roleId;
  const gainRoleNames = [...new Set(gains.map(({ roleId }) => roleName(roleId)))].sort((left, right) => left.localeCompare(right));
  const gainName = gainRoleNames.length === 0 ? "" : gainRoleNames.join(", ");
  const totalGains = new Set(gains.map(({ discordUserId, roleId }) => `${discordUserId}:${roleId}`)).size;
  return {
    gain: { count: totalGains, roleName: gainName },
    lose: [...lossesByRole.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([roleId, people]) => ({
      count: people.size,
      roleName: roleName(roleId),
    })),
  };
};
