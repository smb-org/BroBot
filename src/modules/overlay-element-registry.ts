import type { ModuleOverlayElementDefinition } from "./contract";
import { adsCountdownElement } from "./ads/overlay/element";

export interface RegisteredOverlayElement {
  moduleId: string;
  definition: ModuleOverlayElementDefinition;
}

export const MODULE_OVERLAY_ELEMENTS: readonly RegisteredOverlayElement[] = [
  { moduleId: "ads", definition: adsCountdownElement },
];
