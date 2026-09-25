export type OverlayLanguage = "de" | "en";

export interface OverlayElementData {
  id: string;
  kind: string;
  label: string;
  variableName: string | null;
  text: string;
  config?: Readonly<Record<string, unknown>>;
  state?: Readonly<Record<string, unknown>> | null;
  moduleEnabled?: boolean;
  x: number;
  y: number;
  scalePercent: number;
  z: number;
  inComposition: boolean;
}

export interface BoundOverlayData {
  id: string;
  revision: number;
  width: number;
  height: number;
  css: string;
  elements: readonly OverlayElementData[];
}

export interface OverlayBootstrapData {
  language: OverlayLanguage;
  overlay: BoundOverlayData | null;
  variables: Readonly<Record<string, number>>;
}
