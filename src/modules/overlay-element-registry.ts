import type { ModuleOverlayElementDefinition } from "./contract";
import { adsOverlayElements } from "./ads/overlay/element";

export interface RegisteredOverlayElement {
  moduleId: string;
  definition: ModuleOverlayElementDefinition;
}

export const MODULE_OVERLAY_ELEMENTS: readonly RegisteredOverlayElement[] = [
  ...adsOverlayElements.map((definition) => ({ moduleId: "ads", definition })),
];
