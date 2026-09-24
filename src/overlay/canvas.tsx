import { Component, type CSSProperties, type ReactElement, type ReactNode } from "react";

import { VariableValueView } from "./variable-view";
import type { BoundOverlayData, OverlayElementData, OverlayLanguage } from "./model";

interface OverlayCanvasProperties {
  overlay: BoundOverlayData;
  language: OverlayLanguage;
  variables: Readonly<Record<string, number>>;
  elementId: string | null;
  debug: boolean;
}

interface ElementBoundaryProperties {
  children: ReactNode;
}

interface ElementBoundaryState {
  failed: boolean;
}

class ElementErrorBoundary extends Component<ElementBoundaryProperties, ElementBoundaryState> {
  public override state: ElementBoundaryState = { failed: false };

  public static getDerivedStateFromError(): ElementBoundaryState {
    return { failed: true };
  }

  public override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const renderElement = (
  element: OverlayElementData,
  language: OverlayLanguage,
  variables: Readonly<Record<string, number>>,
  isolated: boolean,
): ReactElement | null => {
  if (element.kind !== "variable" || element.variableName === null) return null;
  if (!Object.hasOwn(variables, element.variableName)) return null;
  const value = variables[element.variableName];
  if (value === undefined) return null;

  const scale = element.scalePercent / 100;
  const style: CSSProperties = {
    position: isolated ? "relative" : "absolute",
    left: isolated ? 0 : element.x,
    top: isolated ? 0 : element.y,
    transform: `scale(${String(scale)})`,
    transformOrigin: "top left",
    zIndex: element.z,
  };
  return <div data-element={element.id} data-kind={element.kind} style={style}>
    <VariableValueView
      name={element.variableName}
      text={element.text}
      value={value}
      language={language}
    />
  </div>;
};

/** Draws the stored composition, or the same element at its standalone origin. */
export const OverlayCanvas = ({ overlay, language, variables, elementId, debug }: OverlayCanvasProperties): ReactElement | null => {
  const isolatedElement = elementId === null
    ? null
    : overlay.elements.find((element) => element.id === elementId) ?? null;
  if (elementId !== null && isolatedElement === null) return null;

  const elements = isolatedElement === null
    ? [...overlay.elements].filter((element) => element.inComposition).sort((left, right) => left.z - right.z)
    : [isolatedElement];
  const canvasStyle: CSSProperties = isolatedElement === null
    ? { position: "relative", width: overlay.width, height: overlay.height }
    : { position: "relative", width: "max-content", height: "max-content" };

  return <div className="brobot-overlay" style={canvasStyle}>
    {elements.map((element) => {
      const value = element.variableName !== null && Object.hasOwn(variables, element.variableName)
        ? variables[element.variableName]
        : null;
      const resetKey = JSON.stringify([overlay.revision, element, language, value, isolatedElement !== null]);
      return <ElementErrorBoundary key={resetKey}>
      {renderElement(element, language, variables, isolatedElement !== null)}
      </ElementErrorBoundary>;
    })}
    {debug && elements.length === 0 ? <span className="brobot-overlay-debug">No visible overlay elements.</span> : null}
  </div>;
};
