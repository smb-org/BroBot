import { describe, expect, it } from "vitest";

import {
  CHANNEL_ROLES,
  ROLE_MATRIX_ACTIONS,
  canManage,
  hasRequiredChannelRole,
  roleMatrixAllows,
} from "../../src/contracts/values";
import { requiredActorRoles } from "../../src/worker/db/guards";

describe("role matrix enforcement rules", () => {
  it("keeps every displayed role cell aligned with the corresponding authorization helper", () => {
    for (const action of ROLE_MATRIX_ACTIONS) {
      for (const role of CHANNEL_ROLES) {
        const enforced = action.access === "member"
          ? CHANNEL_ROLES.includes(role)
          : action.access === "manager"
            ? canManage(role)
            : action.access === "operator"
              ? hasRequiredChannelRole(role, "operator")
              : requiredActorRoles("broadcaster").includes(role);
        expect(roleMatrixAllows(role, action.access), `${action.id} for ${role}`).toBe(enforced);
      }
    }
  });

  it("shows the expected number of actions", () => {
    expect(ROLE_MATRIX_ACTIONS).toHaveLength(12);
  });
});
