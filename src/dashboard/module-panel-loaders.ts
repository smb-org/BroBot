import type { ComponentType } from "react";

import { MODULES } from "../modules/registry";
import type { ModulePanelProperties } from "../modules/contract";

type RegisteredModule = (typeof MODULES)[number];

const moduleLoaderPromises = new Map<string, Promise<unknown>>();

const memoizedModuleLoad = <T,>(moduleId: string, part: string, loader: () => Promise<T>): Promise<T> => {
  const key = `${moduleId}:${part}`;
  const cached = moduleLoaderPromises.get(key);
  if (cached !== undefined) return cached as Promise<T>;
  const promise = loader();
  moduleLoaderPromises.set(key, promise);
  return promise;
};

export const loadModulePanel = (module: RegisteredModule): Promise<{ default: ComponentType<ModulePanelProperties> }> | null =>
  module.panel === undefined ? null : memoizedModuleLoad(module.id, "panel", module.panel);

export const loadModuleSettingsEditor = (moduleId: string): ReturnType<NonNullable<RegisteredModule["settingsEditor"]>> | null => {
  const module = MODULES.find((candidate) => candidate.id === moduleId);
  return module?.settingsEditor === undefined
    ? null
    : memoizedModuleLoad(module.id, "settingsEditor", module.settingsEditor);
};

export const loadModuleImmediateActions = (moduleId: string): ReturnType<NonNullable<NonNullable<RegisteredModule["immediateActions"]>["load"]>> | null => {
  const module = MODULES.find((candidate) => candidate.id === moduleId);
  return module?.immediateActions === undefined
    ? null
    : memoizedModuleLoad(module.id, "immediateActions", module.immediateActions.load);
};

/** Starts all dashboard chunks registered for a module without mounting them. */
export const preloadModulePanel = (moduleId: string): Promise<void> => {
  const module = MODULES.find((candidate) => candidate.id === moduleId);
  if (module === undefined) return Promise.resolve();
  const loads: Promise<unknown>[] = [];
  const panelLoad = loadModulePanel(module);
  const settingsLoad = loadModuleSettingsEditor(moduleId);
  const actionsLoad = loadModuleImmediateActions(moduleId);
  if (panelLoad !== null) loads.push(panelLoad);
  if (settingsLoad !== null) loads.push(settingsLoad);
  if (actionsLoad !== null) loads.push(actionsLoad);
  return Promise.all(loads).then(() => undefined);
};
