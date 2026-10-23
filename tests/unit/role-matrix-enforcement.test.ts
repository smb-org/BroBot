import { describe, expect, it } from "vitest";

import {
  CHANNEL_ROLES,
  ROLE_MATRIX_ACTIONS,
  type RoleMatrixActionId,
  canManage,
  roleMatrixAllows,
} from "../../src/contracts/values";
import { authorizeChannelAccess } from "../../src/worker/auth/authorization";
import { actorGuard, requiredActorRoles } from "../../src/worker/db/guards";
import { authorizeModuleManagementMutation, authorizeModuleMutation } from "../../src/worker/module-authorization";

type ChannelRole = (typeof CHANNEL_ROLES)[number];
type AuthorizationCheck = { source: string; allows: (role: ChannelRole) => boolean | Promise<boolean> };
const actor = { userId: "role-matrix-user", sessionId: "role-matrix-session" };
const channelId = "role-matrix-channel";
const now = "2026-10-22T10:00:00.000Z";

const sqlGuardAllows = (sql: string, role: ChannelRole): boolean => sql.includes(`'${role}'`);
const moduleMutationAllows = (role: ChannelRole): boolean => sqlGuardAllows(
  authorizeModuleMutation(channelId, actor, now).sql,
  role,
);
const moduleManagementMutationAllows = (role: ChannelRole): boolean => sqlGuardAllows(
  authorizeModuleManagementMutation(channelId, actor, now).sql,
  role,
);
const broadcasterAssignmentAllows = (role: ChannelRole): boolean => sqlGuardAllows(
  actorGuard(requiredActorRoles("broadcaster")),
  role,
);

const channelAccessAllows = async (role: ChannelRole): Promise<boolean> => {
  const database = {
    prepare: () => ({
      bind: () => ({ first: () => Promise.resolve({ role }) }),
    }),
  } as unknown as D1Database;
  const authorizedRole = await authorizeChannelAccess(database, { userId: actor.userId }, channelId);
  return authorizedRole !== null;
};

const serverAuthorizationByAction: Record<RoleMatrixActionId, readonly AuthorizationCheck[]> = {
  view_channel: [{ source: "authorizeChannelAccess", allows: channelAccessAllows }],
  manage_access: [{ source: "member route canManage guard", allows: canManage }],
  manage_commands: [
    { source: "command route canManage guard", allows: canManage },
    { source: "authorizeModuleManagementMutation", allows: moduleManagementMutationAllows },
  ],
  toggle_commands: [{ source: "authorizeModuleMutation", allows: moduleMutationAllows }],
  run_voting: [{ source: "authorizeModuleMutation", allows: moduleMutationAllows }],
  send_shoutouts_clips: [{ source: "authorizeModuleMutation", allows: moduleMutationAllows }],
  manage_votekicks: [{ source: "authorizeModuleMutation", allows: moduleMutationAllows }],
  manage_operations: [{ source: "authorizeModuleMutation", allows: moduleMutationAllows }],
  adjust_counters: [{ source: "counter route canManage guard", allows: canManage }],
  manage_ads: [{ source: "ads route canManage guard", allows: canManage }],
  manage_broadcast: [{ source: "broadcast route canManage guard", allows: canManage }],
  assign_broadcaster: [{ source: "broadcaster assignment actorGuard", allows: broadcasterAssignmentAllows }],
};

describe("role matrix enforcement rules", () => {
  it("keeps every displayed role cell aligned with the route and mutation authorization guards", async () => {
    for (const action of ROLE_MATRIX_ACTIONS) {
      for (const role of CHANNEL_ROLES) {
        for (const check of serverAuthorizationByAction[action.id]) {
          expect(
            await check.allows(role),
            `${action.id} for ${role} via ${check.source}`,
          ).toBe(roleMatrixAllows(role, action.access));
        }
      }
    }
  });

  it("keeps manage_ads manager-only like the ads route canManage guard", () => {
    const action = ROLE_MATRIX_ACTIONS.find(({ id }) => id === "manage_ads");

    expect(action).toBeDefined();
    expect(roleMatrixAllows("operator", action?.access ?? "member")).toBe(canManage("operator"));
  });

  it("shows the expected number of actions", () => {
    expect(ROLE_MATRIX_ACTIONS).toHaveLength(12);
  });
});
