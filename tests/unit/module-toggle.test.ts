import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DashboardApi from "../../src/dashboard/api";
import type { PanelChannelOverview, PanelModuleState } from "../../src/panel-contract";
import { setChannelModuleEnabled } from "../../src/dashboard/api";
import { queryKeys } from "../../src/dashboard/data/keys";
import { toggleModuleWithUndo } from "../../src/dashboard/data/module-toggle";

vi.mock("../../src/dashboard/api", async (importOriginal) => ({
  ...await importOriginal<typeof DashboardApi>(),
  setChannelModuleEnabled: vi.fn(),
}));

describe("module toggle response cache", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps known permission metadata when a toggle response marks it unknown (protects=dashboard module and overview caches retain previously known required and missing scopes after an incomplete committed response; fails_when=the cached module drops either scope list, labels the state as known despite missing scopes, or loses the committed enabled value; no_claim=permission metadata when no prior module state is cached)", async () => {
    const channelId = "scope-cache-channel";
    const moduleId = "scoped-module";
    const knownModule: PanelModuleState = {
      id: moduleId,
      enabled: false,
      settings: "{}",
      requiredBroadcasterScopes: ["channel:manage:polls", "channel:read:redemptions"],
      missingBroadcasterScopes: ["channel:manage:polls"],
    };
    const queryClient = new QueryClient();
    const overviewKey = queryKeys.channel(channelId, "overview");
    queryClient.setQueryDefaults(overviewKey, {
      queryFn: () => Promise.resolve(queryClient.getQueryData<PanelChannelOverview>(overviewKey) as PanelChannelOverview),
    });
    queryClient.setQueryData(queryKeys.channel(channelId, "modules"), { modules: [knownModule] });
    queryClient.setQueryData(overviewKey, {
      modules: [knownModule],
      activeModules: [],
    });
    vi.mocked(setChannelModuleEnabled).mockResolvedValue({
      module: {
        id: moduleId,
        enabled: true,
        settings: "{}",
        broadcasterScopeMetadataUnknown: true,
      },
      revision: 2,
    });

    await toggleModuleWithUndo(queryClient, channelId, moduleId, true, () => false);

    const cachedModule = queryClient.getQueryData<{ modules: PanelModuleState[] }>(queryKeys.channel(channelId, "modules"))?.modules[0];
    const overviewModule = queryClient.getQueryData<PanelChannelOverview>(overviewKey)?.modules?.[0];
    for (const module of [cachedModule, overviewModule]) {
      expect(module).toMatchObject({
        id: moduleId,
        enabled: true,
        requiredBroadcasterScopes: ["channel:manage:polls", "channel:read:redemptions"],
        missingBroadcasterScopes: ["channel:manage:polls"],
      });
      expect(module).not.toHaveProperty("broadcasterScopeMetadataUnknown");
    }
    expect(queryClient.getQueryData<PanelChannelOverview>(overviewKey)?.activeModules)
      .toEqual([{ moduleId, settings: "{}" }]);
    queryClient.clear();
  });
});
