import type { QueryClient, QueryFilters } from "@tanstack/react-query";

import type { PanelChannelOverview, PanelChannelsResponse, PanelModuleState, PanelModulesResponse } from "../../panel-contract";
import { PanelApiError, setChannelModuleEnabled } from "../api";
import { apiErrorText, dashboardTexts } from "../locale";
import { moduleDependencyErrorMessage } from "../module-dependencies";
import { moduleName, moduleWorkspaceTexts } from "../module-labels";
import { dismissToastsForScope, notify } from "../ui/toast-store";
import { queryKeys } from "./keys";

interface AppliedModuleState {
  revision: number;
  generation: number;
  module: PanelModuleState;
}

const appliedModuleStates = new WeakMap<QueryClient, Map<string, Map<string, AppliedModuleState>>>();
const moduleToggleGenerations = new WeakMap<QueryClient, Map<string, number>>();

export const moduleToggleToastScope = (channelId: string): string => `module-toggle:${channelId}`;

export const dismissModuleToggleToasts = (channelId: string): void => {
  dismissToastsForScope(moduleToggleToastScope(channelId));
};

/**
 * Refresh all channel surfaces that derive their state from module activation.
 * In-flight overview requests are cancelled first so a stale response cannot
 * restore the old active-module set.
 */
const refreshAfterModuleToggle = async (queryClient: QueryClient, channelId: string): Promise<void> => {
  const overview: QueryFilters = { queryKey: queryKeys.channel(channelId, "overview"), exact: true };
  const modules: QueryFilters = { queryKey: queryKeys.channel(channelId, "modules"), exact: true };
  const channels: QueryFilters = { queryKey: queryKeys.channels(), exact: true };
  const moduleSettings = queryClient.getQueryCache()
    .findAll({ queryKey: ["channel", channelId, "module"] })
    .filter((query) => query.queryKey[4] === "settings")
    .map(({ queryKey }) => ({ queryKey, exact: true }));
  const refreshes = [overview, modules, channels, ...moduleSettings];
  await Promise.all(refreshes.map((filter) => queryClient.cancelQueries(filter)));
  await Promise.all([
    queryClient.invalidateQueries({ ...overview, refetchType: "all" }),
    queryClient.invalidateQueries(modules),
    queryClient.invalidateQueries(channels),
    ...moduleSettings.map((filter) => queryClient.invalidateQueries(filter)),
  ]);
};

const mergeUnknownScopeMetadata = (updated: PanelModuleState, previous: PanelModuleState | undefined): PanelModuleState => {
  if (updated.broadcasterScopeMetadataUnknown !== true || previous === undefined ||
      previous.broadcasterScopeMetadataUnknown === true || previous.requiredBroadcasterScopes === undefined ||
      previous.missingBroadcasterScopes === undefined) return updated;
  const known = { ...updated };
  delete known.broadcasterScopeMetadataUnknown;
  return {
    ...known,
    requiredBroadcasterScopes: [...previous.requiredBroadcasterScopes],
    missingBroadcasterScopes: [...previous.missingBroadcasterScopes],
  };
};

const withModuleState = (modules: readonly PanelModuleState[] | undefined, updated: PanelModuleState): PanelModuleState[] => {
  const current = [...(modules ?? [])];
  const index = current.findIndex(({ id }) => id === updated.id);
  if (index < 0) return [...current, updated];
  current[index] = mergeUnknownScopeMetadata(updated, current[index]);
  return current;
};

export const moduleToggleGeneration = (queryClient: QueryClient, channelId: string): number =>
  moduleToggleGenerations.get(queryClient)?.get(channelId) ?? 0;

/** Preserve mutation responses when an overview request began before a toggle finished. */
export const reconcileOverviewAfterModuleToggle = (
  queryClient: QueryClient,
  channelId: string,
  startedAtGeneration: number,
  overview: PanelChannelOverview,
): PanelChannelOverview => {
  if (moduleToggleGeneration(queryClient, channelId) <= startedAtGeneration) return overview;
  const changedModules = appliedModuleStates.get(queryClient)?.get(channelId);
  if (changedModules === undefined) return overview;

  let modules = overview.modules;
  let activeModules = overview.activeModules;
  for (const { generation, module } of changedModules.values()) {
    if (generation <= startedAtGeneration) continue;
    modules = withModuleState(modules, module);
    activeModules = activeModules.filter(({ moduleId }) => moduleId !== module.id);
    if (module.enabled) activeModules = [...activeModules, { moduleId: module.id, settings: module.settings }];
  }
  return { ...overview, ...(modules === undefined ? {} : { modules }), activeModules };
};

/** Keep the mutation response visible if one of the follow-up reads fails. */
const applyModuleResponse = (queryClient: QueryClient, channelId: string, updated: PanelModuleState, revision: number): void => {
  const statesByChannel = appliedModuleStates.get(queryClient) ?? new Map<string, Map<string, AppliedModuleState>>();
  const current = statesByChannel.get(channelId) ?? new Map<string, AppliedModuleState>();
  const known = current.get(updated.id);
  if (known !== undefined && revision < known.revision) return;
  const cachedModules = queryClient.getQueryData<PanelModulesResponse>(queryKeys.channel(channelId, "modules"))?.modules;
  const cachedOverview = queryClient.getQueryData<PanelChannelOverview>(queryKeys.channel(channelId, "overview"))?.modules;
  const cachedChannels = queryClient.getQueryData<PanelChannelsResponse>(queryKeys.channels())?.channels
    .find((channel) => channel.channelId === channelId)?.modules;
  const previousScopeState = [
    known?.module,
    cachedModules?.find(({ id }) => id === updated.id),
    cachedOverview?.find(({ id }) => id === updated.id),
    cachedChannels?.find(({ id }) => id === updated.id),
  ].find((module) => module !== undefined && module.broadcasterScopeMetadataUnknown !== true &&
    module.requiredBroadcasterScopes !== undefined && module.missingBroadcasterScopes !== undefined);
  const module = mergeUnknownScopeMetadata(updated, previousScopeState);
  const generationsByChannel = moduleToggleGenerations.get(queryClient) ?? new Map<string, number>();
  const generation = (generationsByChannel.get(channelId) ?? 0) + 1;
  generationsByChannel.set(channelId, generation);
  moduleToggleGenerations.set(queryClient, generationsByChannel);
  current.set(module.id, { revision, generation, module });
  statesByChannel.set(channelId, current);
  appliedModuleStates.set(queryClient, statesByChannel);

  queryClient.setQueryData<PanelModulesResponse>(queryKeys.channel(channelId, "modules"), (current) =>
    current === undefined ? current : { ...current, modules: withModuleState(current.modules, module) });

  queryClient.setQueryData<PanelChannelsResponse>(queryKeys.channels(), (current) => current === undefined ? current : ({
    ...current,
    channels: current.channels.map((channel) => channel.channelId !== channelId
      ? channel
      : { ...channel, modules: withModuleState(channel.modules, module) }),
  }));

  queryClient.setQueryData<PanelChannelOverview>(queryKeys.channel(channelId, "overview"), (current) => {
    if (current === undefined) return current;
    const activeModules = current.activeModules.filter(({ moduleId }) => moduleId !== module.id);
    if (module.enabled) activeModules.push({ moduleId: module.id, settings: module.settings });
    return { ...current, modules: withModuleState(current.modules, module), activeModules };
  });
};

const reportToggleError = (
  error: unknown,
  moduleId: string,
  modules: readonly PanelModuleState[],
  scope: string,
): void => {
  const texts = dashboardTexts();
  const dependencyError = error instanceof PanelApiError
    ? moduleDependencyErrorMessage(moduleId, error.code, error.details, modules)
    : null;
  if (dependencyError !== null) {
    notify({ tone: "error", message: dependencyError, scope });
    return;
  }
  if (error instanceof PanelApiError && error.status === 409) {
    notify({ tone: "error", message: moduleWorkspaceTexts().undoConflict, scope });
    return;
  }
  notify({
    tone: "error",
    message: error instanceof PanelApiError
      ? apiErrorText(error.code, texts.errors.changeFailed)
      : texts.errors.changeFailed,
    scope,
  });
};

const refreshQuietly = async (queryClient: QueryClient, channelId: string, scope: string, shouldShowToast: () => boolean): Promise<void> => {
  try {
    await refreshAfterModuleToggle(queryClient, channelId);
  } catch {
    if (shouldShowToast()) notify({ tone: "error", message: dashboardTexts().errors.dataLoadFailed, scope });
  }
};

const undoModuleToggle = async (
  queryClient: QueryClient,
  channelId: string,
  moduleId: string,
  enabled: boolean,
  expectedRevision: number,
  scope: string,
  shouldShowToast: () => boolean,
): Promise<void> => {
  try {
    const result = await setChannelModuleEnabled(channelId, moduleId, !enabled, expectedRevision);
    applyModuleResponse(queryClient, channelId, result.module, result.revision);
    await refreshQuietly(queryClient, channelId, scope, shouldShowToast);
  } catch (error: unknown) {
    if (shouldShowToast()) {
      const modules = queryClient.getQueryData<PanelModulesResponse>(queryKeys.channel(channelId, "modules"))?.modules ?? [];
      reportToggleError(error, moduleId, modules, scope);
    }
  }
};

/** The shared mutation and per-toast Undo used by module rows, headers, and the command palette. */
export const toggleModuleWithUndo = async (
  queryClient: QueryClient,
  channelId: string,
  moduleId: string,
  enabled: boolean,
  shouldShowToast: () => boolean = () => true,
): Promise<{ module: PanelModuleState; revision: number }> => {
  const result = await setChannelModuleEnabled(channelId, moduleId, enabled);
  const scope = moduleToggleToastScope(channelId);
  applyModuleResponse(queryClient, channelId, result.module, result.revision);
  await refreshQuietly(queryClient, channelId, scope, shouldShowToast);
  if (!shouldShowToast()) return result;
  const labels = moduleWorkspaceTexts();
  notify({
    tone: "success",
    message: labels.changed(moduleName(moduleId), enabled),
    scope,
    action: {
      label: labels.undo,
      onClick: () => { void undoModuleToggle(queryClient, channelId, moduleId, enabled, result.revision, scope, shouldShowToast); },
    },
  });
  return result;
};
