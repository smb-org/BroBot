import { describe, expect, it } from "vitest";

import {
  CHANNEL_ROLES,
  ROLE_MATRIX_ACTIONS,
  canManage,
  roleMatrixAllows,
} from "../../src/contracts/values";
import { ANY_MEMBER_ROLES, requiredActorRoles } from "../../src/worker/db/guards";

const serverAuthorizationByAction = {
  view_channel: (role: (typeof CHANNEL_ROLES)[number]) => ANY_MEMBER_ROLES.includes(role),
  manage_access: canManage,
  manage_commands: canManage,
  toggle_commands: (role: (typeof CHANNEL_ROLES)[number]) => ANY_MEMBER_ROLES.includes(role),
  run_voting: (role: (typeof CHANNEL_ROLES)[number]) => ANY_MEMBER_ROLES.includes(role),
  send_shoutouts_clips: (role: (typeof CHANNEL_ROLES)[number]) => ANY_MEMBER_ROLES.includes(role),
  manage_votekicks: (role: (typeof CHANNEL_ROLES)[number]) => ANY_MEMBER_ROLES.includes(role),
  manage_operations: (role: (typeof CHANNEL_ROLES)[number]) => ANY_MEMBER_ROLES.includes(role),
  adjust_counters: canManage,
  manage_ads: canManage,
  manage_broadcast: canManage,
  assign_broadcaster: (role: (typeof CHANNEL_ROLES)[number]) => requiredActorRoles("broadcaster").includes(role),
} as const;

describe("role matrix enforcement rules", () => {
  it("keeps every displayed role cell aligned with the corresponding authorization helper", () => {
    for (const action of ROLE_MATRIX_ACTIONS) {
      for (const role of CHANNEL_ROLES) {
        expect(roleMatrixAllows(role, action.access), `${action.id} for ${role}`).toBe(serverAuthorizationByAction[action.id](role));
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
