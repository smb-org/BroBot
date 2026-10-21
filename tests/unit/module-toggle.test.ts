import { QueryClient, QueryObserver } from "@tanstack/react-query";
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

  it("leaves fresh cached scopes untouched and refetches the module list once for an unknown toggle response (protects=unknown toggle responses preserve the latest required and missing scopes instead of restoring an older mutation snapshot while refreshing module metadata exactly once; fails_when=the cached scope metadata regresses or the module list is not refetched exactly once; no_claim=scope metadata when the cache has no prior module state)", async () => {
    const channelId = "scope-cache-channel";
    const moduleId = "scoped-module";
    const oldRequiredScopes = ["channel:manage:polls", "channel:read:redemptions"];
    const oldMissingScopes = ["channel:manage:polls"];
    const oldModule: PanelModuleState = {
      id: moduleId,
      enabled: false,
      settings: "{}",
      requiredBroadcasterScopes: oldRequiredScopes,
      missingBroadcasterScopes: oldMissingScopes,
    };
    const freshRequiredScopes = ["channel:manage:polls", "channel:read:subscriptions"];
    const freshMissingScopes = ["channel:read:subscriptions"];
    const freshModule: PanelModuleState = {
      id: moduleId,
      enabled: false,
      settings: "{}",
      requiredBroadcasterScopes: freshRequiredScopes,
      missingBroadcasterScopes: freshMissingScopes,
    };
    const queryClient = new QueryClient();
    const modulesKey = queryKeys.channel(channelId, "modules");
    const overviewKey = queryKeys.channel(channelId, "overview");
    queryClient.setQueryDefaults(overviewKey, {
      queryFn: () => Promise.resolve(queryClient.getQueryData<PanelChannelOverview>(overviewKey) as PanelChannelOverview),
    });
    let moduleListRefetches = 0;
    let captureUnknownRefetch = false;
    let moduleAtRefetch: PanelModuleState | undefined;
    let overviewModuleAtRefetch: PanelModuleState | undefined;
    queryClient.setQueryData(modulesKey, { modules: [oldModule] });
    queryClient.setQueryData(overviewKey, {
      modules: [oldModule],
      activeModules: [],
    });
    const moduleListObserver = new QueryObserver(queryClient, {
      queryKey: modulesKey,
      staleTime: Infinity,
      queryFn: () => {
        const cachedModule = queryClient.getQueryData<{ modules: PanelModuleState[] }>(modulesKey)?.modules[0];
        if (captureUnknownRefetch) {
          moduleListRefetches += 1;
          moduleAtRefetch = cachedModule;
          overviewModuleAtRefetch = queryClient.getQueryData<PanelChannelOverview>(overviewKey)?.modules?.[0];
          return Promise.resolve({ modules: [freshModule] });
        }
        return Promise.resolve({ modules: cachedModule === undefined ? [] : [cachedModule] });
      },
    });
    const unsubscribe = moduleListObserver.subscribe(() => undefined);
    vi.mocked(setChannelModuleEnabled).mockResolvedValue({
      module: {
        id: moduleId,
        enabled: true,
        settings: "{}",
        requiredBroadcasterScopes: oldRequiredScopes,
        missingBroadcasterScopes: oldMissingScopes,
      },
      revision: 2,
    });

    await toggleModuleWithUndo(queryClient, channelId, moduleId, true, () => false);

    queryClient.setQueryData(modulesKey, { modules: [{ ...freshModule, enabled: true }] });
    queryClient.setQueryData<PanelChannelOverview>(overviewKey, (current) => current === undefined ? current : ({
      ...current,
      modules: [{ ...freshModule, enabled: true }],
      activeModules: [{ moduleId, settings: "{}" }],
    }));
    captureUnknownRefetch = true;
    moduleListRefetches = 0;
    vi.mocked(setChannelModuleEnabled).mockResolvedValue({
      module: {
        id: moduleId,
        enabled: false,
        settings: "{}",
        broadcasterScopeMetadataUnknown: true,
      },
      revision: 3,
    });

    await toggleModuleWithUndo(queryClient, channelId, moduleId, false, () => false);

    expect(moduleAtRefetch).toMatchObject({
      requiredBroadcasterScopes: freshRequiredScopes,
      missingBroadcasterScopes: freshMissingScopes,
    });
    expect(overviewModuleAtRefetch).toMatchObject({
      requiredBroadcasterScopes: freshRequiredScopes,
      missingBroadcasterScopes: freshMissingScopes,
    });
    expect(moduleListRefetches).toBe(1);
    expect(queryClient.getQueryData<{ modules: PanelModuleState[] }>(modulesKey)?.modules[0]).toMatchObject({
      enabled: false,
      requiredBroadcasterScopes: freshRequiredScopes,
      missingBroadcasterScopes: freshMissingScopes,
    });
    const overviewModule = queryClient.getQueryData<PanelChannelOverview>(overviewKey)?.modules?.[0];
    expect(overviewModule?.requiredBroadcasterScopes).toEqual(freshRequiredScopes);
    expect(overviewModule?.missingBroadcasterScopes).toEqual(freshMissingScopes);
    expect(overviewModule?.enabled).toBe(false);
    expect(queryClient.getQueryData<PanelChannelOverview>(overviewKey)?.activeModules)
      .toEqual([]);
    unsubscribe();
    queryClient.clear();
  });
});
