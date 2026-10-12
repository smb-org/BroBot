import type { TemplateVariable } from "../template";

export type EventTemplateVariable = {
  contexts?: TemplateVariable["contexts"] | undefined;
  availableInEventTemplates?: boolean | undefined;
};

export const isEventTemplateVariableAvailable = (variable: EventTemplateVariable): boolean =>
  (variable.contexts === undefined || variable.contexts.includes("event")) && variable.availableInEventTemplates !== false;
