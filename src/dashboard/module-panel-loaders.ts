import type { ComponentType } from "react";

import { MODULES } from "../modules/registry";
import { MODULE_OVERLAY_ELEMENTS } from "../modules/overlay-element-registry";
import type { ModuleOverlayElementDefinition, ModulePanelProperties } from "../modules/contract";

type RegisteredModule = (typeof MODULES)[number];

const moduleLoaderPromises = new Map<string, Promise<unknown>>();

export class ModuleChunkLoadError extends Error {
  constructor(moduleId: string, part: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not load ${moduleId} ${part}: ${detail}`);
    this.name = "ModuleChunkLoadError";
  }
}

/** A failed native import is cached by the browser for this document; reload to retry it with a fresh module map. */
export const retryModuleChunkLoad = (): void => { window.location.reload(); };

export const memoizedModuleLoad = <T,>(moduleId: string, part: string, loader: () => Promise<T>): Promise<T> => {
  const key = `${moduleId}:${part}`;
  const cached = moduleLoaderPromises.get(key);
  if (cached !== undefined) return cached as Promise<T>;
  const cacheEntry: { promise: Promise<T> | undefined } = { promise: undefined };
  // Run the loader now, while converting synchronous throws into rejections.
  const loadPromise = new Promise<T>((resolve) => {
    resolve(loader());
  });
  const promise = loadPromise.catch((error: unknown) => {
    if (moduleLoaderPromises.get(key) === cacheEntry.promise) moduleLoaderPromises.delete(key);
    throw error instanceof ModuleChunkLoadError ? error : new ModuleChunkLoadError(moduleId, part, error);
  });
  cacheEntry.promise = promise;
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

export const loadModuleOverlayElementEditor = (kind: string): ReturnType<NonNullable<ModuleOverlayElementDefinition["editor"]>> | null => {
  const registered = MODULE_OVERLAY_ELEMENTS.find((entry) => entry.definition.kind === kind);
  return registered?.definition.editor === undefined
    ? null
    : memoizedModuleLoad(registered.moduleId, `overlay-editor:${kind}`, registered.definition.editor);
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
