import type { ModuleOverlayElementDefinition } from "./contract";
import { adsOverlayElements } from "./ads/overlay/element";
import { textBlockOverlayElement } from "./text_library/overlay/element";
import { chatVotingOverlayElements } from "./chat_voting/overlay/element";

export interface RegisteredOverlayElement {
  moduleId: string;
  definition: ModuleOverlayElementDefinition;
}

export const MODULE_OVERLAY_ELEMENTS: readonly RegisteredOverlayElement[] = [
  ...chatVotingOverlayElements.map((definition) => ({ moduleId: "chat_voting", definition })),
  { moduleId: "text_library", definition: textBlockOverlayElement },
  ...adsOverlayElements.map((definition) => ({ moduleId: "ads", definition })),
];

export const moduleOverlayMessageRequiresStateReload = (messageType: string): boolean =>
  MODULE_OVERLAY_ELEMENTS.some(({ moduleId, definition }) =>
    definition.reloadStateOnModuleMessages?.includes(messageType) === true ||
    (definition.reloadStateOnHostEvents !== undefined && messageType === `modul.${moduleId}.state_changed`),
  );
