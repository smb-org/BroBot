import type { PanelModuleState } from "../panel-contract";
import { MODULES } from "../modules/registry";
import { dashboardLanguage, dashboardTexts, type DashboardLanguage } from "./locale";
import { moduleName } from "./module-labels";

const moduleIsEnabled = (modules: readonly PanelModuleState[], moduleId: string): boolean =>
  modules.find((module) => module.id === moduleId)?.enabled === true;

const dependencyNames = (moduleIds: readonly string[], language: DashboardLanguage): string =>
  moduleIds.map((moduleId) => moduleName(moduleId, language)).join(", ");

const serverDependentModules = (details: unknown): string[] | null => {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const values: unknown = Reflect.get(details, "dependentModules");
  return Array.isArray(values) && values.every((value): value is string => typeof value === "string")
    ? values
    : null;
};

export const moduleDependencyLockReason = (
  moduleId: string,
  nextEnabled: boolean,
  modules: readonly PanelModuleState[],
  language: DashboardLanguage = dashboardLanguage(),
): string | null => {
  const definition = MODULES.find((module) => module.id === moduleId);
  if (definition === undefined) return null;
  const texts = dashboardTexts(language).module;

  if (nextEnabled) {
    const missingRequirements = (definition.requiresModules ?? []).filter((requiredId) => !moduleIsEnabled(modules, requiredId));
    return missingRequirements.length === 0
      ? null
      : texts.requiresModulesLock(dependencyNames(missingRequirements, language));
  }

  const enabledDependents = MODULES.filter((module) => module.requiresModules?.includes(moduleId) === true && moduleIsEnabled(modules, module.id));
  return enabledDependents.length === 0
    ? null
    : texts.dependentModulesLock(dependencyNames(enabledDependents.map(({ id }) => id), language));
};

export const moduleDependencyErrorMessage = (
  moduleId: string,
  code: string | null,
  details: unknown,
  modules: readonly PanelModuleState[],
  language: DashboardLanguage = dashboardLanguage(),
): string | null => {
  const definition = MODULES.find((module) => module.id === moduleId);
  if (definition === undefined) return null;
  const texts = dashboardTexts(language).module;

  if (code === "module_requires") {
    const requirements = definition.requiresModules ?? [];
    return requirements.length === 0
      ? null
      : texts.requiresModulesLock(dependencyNames(requirements, language));
  }

  if (code !== "module_required_by") return null;
  const declaredDependents = MODULES.filter((module) => module.requiresModules?.includes(moduleId) === true);
  const byId = new Map(declaredDependents.map((module) => [module.id, module]));
  const serverIds = serverDependentModules(details);
  const dependentIds = serverIds === null
    ? declaredDependents.filter((module) => moduleIsEnabled(modules, module.id)).map(({ id }) => id)
    : serverIds.filter((dependentId) => byId.has(dependentId));
  return dependentIds.length === 0
    ? declaredDependents.length === 0 ? null : texts.dependentModulesLock(dependencyNames(declaredDependents.map(({ id }) => id), language))
    : texts.dependentModulesLock(dependencyNames(dependentIds, language));
};
