import type { ModuleOverlayElementDefinition } from "./contract";
import { adsOverlayElements } from "./ads/overlay/element";
import { textBlockOverlayElement } from "./text_library/overlay/element";
import { chatVotingOverlayElements } from "./chat_voting/overlay/element";
import { belaboxOverlayElements } from "./belabox/overlay/element";

export interface RegisteredOverlayElement {
  moduleId: string;
  definition: ModuleOverlayElementDefinition;
}

export const MODULE_OVERLAY_ELEMENTS: readonly RegisteredOverlayElement[] = [
  ...chatVotingOverlayElements.map((definition) => ({ moduleId: "chat_voting", definition })),
  { moduleId: "text_library", definition: textBlockOverlayElement },
  ...belaboxOverlayElements.map((definition) => ({ moduleId: "belabox", definition })),
  ...adsOverlayElements.map((definition) => ({ moduleId: "ads", definition })),
];

export const moduleOverlayElementKindForMessage = (messageType: string): string => {
  const declared = MODULE_OVERLAY_ELEMENTS.find(({ definition }) =>
    definition.mergeRealtimeStateOnModuleMessages?.includes(messageType) === true);
  return declared?.definition.kind ?? messageType.slice("modul.".length);
};

export const moduleOverlayMessageRequiresStateReload = (messageType: string): boolean =>
  MODULE_OVERLAY_ELEMENTS.some(({ moduleId, definition }) =>
    definition.reloadStateOnModuleMessages?.includes(messageType) === true ||
    (definition.reloadStateOnHostEvents !== undefined && messageType === `modul.${moduleId}.state_changed`),
  );

export const mergeModuleOverlayElementState = (
  elementKind: string,
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => MODULE_OVERLAY_ELEMENTS.find(({ definition }) => definition.kind === elementKind)
  ?.definition.mergeRealtimeState?.(current, incoming) ?? incoming;
