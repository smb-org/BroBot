import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { OVERLAY_ELEMENT_MAXIMUM_COUNT } from "../contracts/values";
import { sanitizeOverlayCss } from "../contracts/overlay-css";
import { OverlayCanvas } from "../overlay/canvas";
import type { BoundOverlayData, OverlayLanguage } from "../overlay/model";
import variableViewCss from "../overlay/variable.css?inline";
import { clampOverlayEditorPosition, overlayEditorPositionLimits, UNMEASURED_ELEMENT_FALLBACK_SIZE } from "./overlay-editor-model";
import {
  parseOverlayStyleBlock,
  replaceOverlayStyleBlock,
  type OverlayStyleAlignment,
  type OverlayStyle,
  type OverlayStyleDocument,
} from "./overlay-style-model";
import { DisabledFieldReasonContext } from "./ui/DisabledFieldReason";
import {
  createOverlay,
  fetchChannelVariables,
  fetchOverlay,
  PanelApiError,
  saveOverlay,
  type PanelChannelVariable,
  type PanelOverlay,
  type PanelOverlayDraft,
  type PanelOverlayElement,
} from "./api";
import { apiErrorText, dashboardLanguage, overlaysTexts } from "./locale";
import { useRealtimeVariableUpdates } from "./realtime";
import { Button, CodeField, ColorField, ConfirmDialog, Field, Icon, NumberField, SaveBar, Select, Switch, type IconName, registerDashboardNavigationGuard, useDraftGuard } from "./ui";
import "./overlay-editor.css";

interface OverlayEditorPageProperties {
  channelId: string;
  overlayId: string;
  canManage: boolean;
  language: OverlayLanguage;
  initialVariable?: string;
  initialOverlayName?: string;
  onBack: () => void;
  onOverlayCreated: (overlayId: string) => void;
}

interface OverlayEditorSession {
  overlay: PanelOverlay;
  baseDraft: PanelOverlayDraft;
  initialDraft: PanelOverlayDraft;
  selectedElementId: string | null;
  initialNotice: InitialNotice;
}

type InitialNotice = { kind: "missing-variable"; name: string } | { kind: "element-limit" } | null;

interface OverlayDraftBaseline {
  revision: number;
  draft: PanelOverlayDraft;
}

interface OverlayEditorWorkspaceProperties {
  channelId: string;
  overlayId: string;
  canManage: boolean;
  language: OverlayLanguage;
  overlay: PanelOverlay;
  baseDraft: PanelOverlayDraft;
  initialDraft: PanelOverlayDraft;
  initialElementId: string | null;
  initialNotice: InitialNotice;
  variables: readonly PanelChannelVariable[];
  liveVariables: Readonly<Record<string, number>>;
  onBack: () => void;
  onReload: () => void;
  onOverlayCreated: (overlayId: string) => void;
}

interface PointerDrag {
  elementId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

interface PreviewEventHandlers {
  pointerDown: (event: PointerEvent) => void;
  pointerMove: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  keyDown: (event: KeyboardEvent) => void;
}

type OverlayStyleSection = "font" | "outline" | "shadow" | "background";

interface StyleDisclosureSectionProperties {
  section: OverlayStyleSection;
  icon: IconName;
  title: string;
  summary: string;
  defaultExpanded: boolean;
  children: ReactNode;
}

function StyleDisclosureSection({ section, icon, title, summary, defaultExpanded, children }: StyleDisclosureSectionProperties): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = `overlay-editor-style-section-${section}`;
  return <section className="overlay-editor__style-section" data-style-section={section}>
    <h3 className="overlay-editor__style-section-heading">
      <button type="button" className="overlay-editor__style-section-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => { setExpanded((current) => !current); }}>
        <span className="overlay-editor__style-section-icon" data-style-icon={section}><Icon name={icon} size={16} /></span>
        <span className="overlay-editor__style-section-title">{title}</span>
        <span className="overlay-editor__style-section-summary" title={summary}>{summary}</span>
        <span className="overlay-editor__style-section-chevron" aria-hidden="true" />
      </button>
    </h3>
    <div className="overlay-editor__style-section-fields" id={panelId} hidden={!expanded}>{children}</div>
  </section>;
}

const styleSectionHasValues = (style: OverlayStyle, section: OverlayStyleSection): boolean => {
  switch (section) {
    case "font":
      return style.fontFamily !== undefined || style.fontSize !== undefined || style.fontWeight !== undefined || style.color !== undefined
        || style.textAlign !== undefined || style.lineHeight !== undefined || style.letterSpacing !== undefined;
    case "outline":
      return style.stroke !== undefined;
    case "shadow":
      return style.shadow !== undefined;
    case "background":
      return style.background !== undefined || style.padding !== undefined || style.borderRadius !== undefined;
  }
};

const styleSectionSummary = (
  style: OverlayStyle,
  section: OverlayStyleSection,
  unsetLabel: string,
  leftAlignmentLabel: string,
  centerAlignmentLabel: string,
  rightAlignmentLabel: string,
): string => {
  const values: string[] = [];
  const add = (value: string | undefined): void => { if (value !== undefined) values.push(value); };
  switch (section) {
    case "font":
      add(style.fontFamily);
      add(style.fontSize === undefined ? undefined : `${String(style.fontSize)} px`);
      add(style.fontWeight === undefined ? undefined : String(style.fontWeight));
      add(style.color);
      add(style.textAlign === "left" ? leftAlignmentLabel : style.textAlign === "center" ? centerAlignmentLabel : style.textAlign === "right" ? rightAlignmentLabel : undefined);
      add(style.lineHeight === undefined ? undefined : String(style.lineHeight));
      add(style.letterSpacing === undefined ? undefined : `${String(style.letterSpacing)} px`);
      break;
    case "outline":
      add(style.stroke?.width === undefined ? undefined : `${String(style.stroke.width)} px`);
      add(style.stroke?.color);
      break;
    case "shadow":
      add(style.shadow?.x === undefined ? undefined : `X ${String(style.shadow.x)} px`);
      add(style.shadow?.y === undefined ? undefined : `Y ${String(style.shadow.y)} px`);
      add(style.shadow?.blur === undefined ? undefined : `${String(style.shadow.blur)} px`);
      add(style.shadow?.color);
      break;
    case "background":
      add(style.background?.color);
      add(style.background?.opacityPercent === undefined ? undefined : `${String(style.background.opacityPercent)}%`);
      add(style.padding === undefined ? undefined : `${String(style.padding)} px`);
      add(style.borderRadius === undefined ? undefined : `${String(style.borderRadius)} px`);
      break;
  }
  return values.length === 0 ? unsetLabel : values.join(" · ");
};

const saveableElement = (element: PanelOverlayElement): PanelOverlayElement => ({
  id: element.id,
  kind: element.kind,
  label: element.label,
  variableName: element.variableName,
  text: element.text,
  config: element.config,
  x: element.x,
  y: element.y,
  scalePercent: element.scalePercent,
  z: element.z,
  inComposition: element.inComposition,
});

const overlayDraft = (overlay: PanelOverlay): PanelOverlayDraft => ({
  name: overlay.name,
  width: overlay.width,
  height: overlay.height,
  css: overlay.css,
  elements: overlay.elements.map(saveableElement),
});

const variableValues = (variables: readonly PanelChannelVariable[]): Readonly<Record<string, number>> =>
  Object.fromEntries(variables.map(({ name, value }) => [name, value]));

const emptyOverlayStyles = (): OverlayStyleDocument => ({ overlay: {}, elements: {} });
const SYSTEM_FONT_FAMILIES = ["system-ui", "Arial", "Georgia", "Trebuchet MS", "Verdana"] as const;

const findRenderedElement = (root: HTMLElement, elementId: string): HTMLElement | undefined =>
  Array.from(root.querySelectorAll<HTMLElement>("[data-element]"))
    .find((element) => element.dataset.element === elementId);

const createVariableElement = (name: string, elements: readonly PanelOverlayElement[]): PanelOverlayElement => ({
  id: crypto.randomUUID(),
  kind: "variable",
  label: name,
  variableName: name,
  text: `${name}: {value}`,
  config: {},
  x: 0,
  y: 0,
  scalePercent: 100,
  z: elements.length === 0 ? 0 : Math.max(...elements.map(({ z }) => z)) + 1,
  inComposition: true,
});

const initialSession = (
  overlay: PanelOverlay,
  variables: readonly PanelChannelVariable[],
  requestedVariable: string | undefined,
): OverlayEditorSession => {
  const baseDraft = overlayDraft(overlay);
  const selectedInitialId = baseDraft.elements[0]?.id ?? null;
  if (requestedVariable === undefined) {
    return { overlay, baseDraft, initialDraft: baseDraft, selectedElementId: selectedInitialId, initialNotice: null };
  }
  if (!variables.some(({ name }) => name === requestedVariable)) {
    return { overlay, baseDraft, initialDraft: baseDraft, selectedElementId: selectedInitialId, initialNotice: { kind: "missing-variable", name: requestedVariable } };
  }
  if (baseDraft.elements.length >= OVERLAY_ELEMENT_MAXIMUM_COUNT) {
    return { overlay, baseDraft, initialDraft: baseDraft, selectedElementId: selectedInitialId, initialNotice: { kind: "element-limit" } };
  }
  const element = createVariableElement(requestedVariable, baseDraft.elements);
  return {
    overlay,
    baseDraft,
    initialDraft: { ...baseDraft, elements: [...baseDraft.elements, element] },
    selectedElementId: element.id,
    initialNotice: null,
  };
};

const conflictRevision = (error: PanelApiError): number | null => {
  if (typeof error.details !== "object" || error.details === null || Array.isArray(error.details)) return null;
  const revision: unknown = Reflect.get(error.details, "currentRevision");
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
};

export function OverlayEditorPage({ channelId, overlayId, canManage, language, initialVariable, initialOverlayName, onBack, onOverlayCreated }: OverlayEditorPageProperties): ReactElement {
  const labels = overlaysTexts(dashboardLanguage());
  const [variables, setVariables] = useState<readonly PanelChannelVariable[]>([]);
  const [session, setSession] = useState<OverlayEditorSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const initialVariableRef = useRef(canManage ? initialVariable : undefined);

  const refreshVariables = useCallback(async (): Promise<void> => {
    const result = await fetchChannelVariables(channelId);
    setVariables(result.variables);
  }, [channelId]);

  useRealtimeVariableUpdates({ channelId, refresh: refreshVariables });

  useEffect(() => {
    let disposed = false;
    const overlayRequest = overlayId === "new"
      ? Promise.resolve({ overlay: {
        id: "new", channelId, name: initialOverlayName ?? "", width: 1920, height: 1080, css: "", revision: 1,
        createdAt: "", updatedAt: "", elements: [],
      } satisfies PanelOverlay })
      : fetchOverlay(channelId, overlayId);
    void Promise.all([overlayRequest, fetchChannelVariables(channelId)])
      .then(([overlayResult, variableResult]) => {
        if (disposed) return;
        setVariables(variableResult.variables);
        const requestedVariable = initialVariableRef.current;
        initialVariableRef.current = undefined;
        if (requestedVariable !== undefined) {
          const currentUrl = new URL(window.location.href);
          currentUrl.searchParams.delete("variable");
          window.history.replaceState(window.history.state, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
        }
        setSession(initialSession(overlayResult.overlay, variableResult.variables, requestedVariable));
      })
      .catch((caught: unknown) => {
        if (disposed) return;
        setLoadError(caught instanceof PanelApiError
          ? apiErrorText(caught.code, labels.editorLoadError)
          : labels.editorLoadError);
      });
    return () => { disposed = true; };
  }, [channelId, initialOverlayName, labels.editorLoadError, loadGeneration, overlayId]);

  const reload = useCallback((): void => {
    setSession(null);
    setLoadError(null);
    setLoadGeneration((current) => current + 1);
  }, []);

  if (loadError !== null) return <section className="overlay-editor overlay-editor--message">
    <Button variant="subtle" onClick={onBack}>{labels.editorBack}</Button>
    <p className="form-error" role="alert">{loadError}</p>
    <Button variant="neutral" onClick={reload}>{labels.editorConflictReload}</Button>
  </section>;
  if (session === null) return <section className="overlay-editor overlay-editor--message"><p className="loading-line">{labels.editorLoading}</p></section>;

  return <OverlayEditorWorkspace
    key={`${overlayId}-${String(loadGeneration)}`}
    channelId={channelId}
    overlayId={overlayId}
    canManage={canManage}
    language={language}
    overlay={session.overlay}
    baseDraft={session.baseDraft}
    initialDraft={session.initialDraft}
    initialElementId={session.selectedElementId}
    initialNotice={session.initialNotice}
    variables={variables}
    liveVariables={variableValues(variables)}
    onBack={onBack}
    onReload={reload}
    onOverlayCreated={onOverlayCreated}
  />;
}

function OverlayEditorWorkspace({
  channelId,
  overlayId,
  canManage,
  language,
  overlay,
  baseDraft,
  initialDraft,
  initialElementId,
  initialNotice,
  variables,
  liveVariables,
  onBack,
  onReload,
  onOverlayCreated,
}: OverlayEditorWorkspaceProperties): ReactElement {
  const labels = overlaysTexts(dashboardLanguage());
  const [draft, setDraft] = useState(initialDraft);
  const [baseline, setBaseline] = useState<OverlayDraftBaseline>({ revision: overlay.revision, draft: baseDraft });
  const [selectedElementId, setSelectedElementId] = useState(initialElementId);
  const [chosenVariableName, setChosenVariableName] = useState(variables[0]?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [conflictAtRevision, setConflictAtRevision] = useState<number | null>(null);
  const [persistedOverlayId, setPersistedOverlayId] = useState<string | null>(null);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [editorTab, setEditorTab] = useState<"properties" | "style" | "css">("properties");
  const [styleTargetId, setStyleTargetId] = useState("overlay");
  const [styleDocument, setStyleDocument] = useState<OverlayStyleDocument>(() => {
    const parsed = parseOverlayStyleBlock(overlay.css);
    return parsed.kind === "valid" ? parsed.styles : emptyOverlayStyles();
  });
  const [cssCopyState, setCssCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [previewFrameRoot, setPreviewFrameRoot] = useState<HTMLDivElement | null>(null);
  const [selectedElementSize, setSelectedElementSize] = useState({ width: 0, height: 0 });
  const previewFrameRootRef = useRef<HTMLDivElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<PointerDrag | null>(null);
  const previewEventHandlers = useRef<PreviewEventHandlers>({
    pointerDown: () => undefined,
    pointerMove: () => undefined,
    pointerUp: () => undefined,
    keyDown: () => undefined,
  });

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline.draft);
  const canEdit = canManage && !saving;
  const selectedElement = draft.elements.find((element) => element.id === selectedElementId) ?? null;
  const selectedElementScalePercent = selectedElement?.scalePercent;
  const selectedElementText = selectedElement?.text;
  const selectedElementVariableName = selectedElement?.variableName ?? null;
  const selectedElementLiveValue = selectedElementVariableName === null ? undefined : liveVariables[selectedElementVariableName];
  const orderedElements = useMemo(() => [...draft.elements].sort((left, right) => right.z - left.z), [draft.elements]);
  const variablesByName = useMemo(() => new Set(variables.map(({ name }) => name)), [variables]);
  const addVariableName = variablesByName.has(chosenVariableName) ? chosenVariableName : variables[0]?.name ?? "";
  const rendererOverlay: BoundOverlayData = {
    id: overlayId,
    revision: baseline.revision,
    width: draft.width,
    height: draft.height,
    css: draft.css,
    elements: draft.elements,
  };
  const parsedStyleBlock = parseOverlayStyleBlock(draft.css);
  const styleLocked = parsedStyleBlock.kind === "invalid";
  const effectiveStyleDocument = parsedStyleBlock.kind === "valid" ? parsedStyleBlock.styles : styleDocument;
  const effectiveStyleTargetId = styleTargetId === "overlay" || draft.elements.some(({ id }) => id === styleTargetId)
    ? styleTargetId
    : "overlay";
  const targetStyle: OverlayStyle = effectiveStyleTargetId === "overlay"
    ? effectiveStyleDocument.overlay
    : effectiveStyleDocument.elements[effectiveStyleTargetId] ?? {};
  const elementHorizontalAnchor = (element: PanelOverlayElement): OverlayStyleAlignment =>
    effectiveStyleDocument.elements[element.id]?.textAlign ?? effectiveStyleDocument.overlay.textAlign ?? "left";
  const selectedElementAnchor = selectedElement === null ? "left" : elementHorizontalAnchor(selectedElement);
  const styleLockedReason = !canManage ? labels.editorStyleReadOnlyReason : styleLocked ? labels.editorStyleLocked : "";
  const fitScale = viewportSize.width === 0 || viewportSize.height === 0
    ? 1
    : Math.min(viewportSize.width / draft.width, viewportSize.height / draft.height);
  const canvasScale = fitScale * previewZoom / 100;
  const textIsValid = draft.elements.every((element) => element.text.match(/\{value\}/gu)?.length === 1);
  const canvasSize = { width: draft.width, height: draft.height };
  const selectedPositionLimits = overlayEditorPositionLimits(canvasSize, selectedElementSize, selectedElementAnchor);

  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (viewport === null) return;
    const measure = (): void => {
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => { observer.disconnect(); };
  }, []);

  const loadPreviewFrame = useCallback((frame: HTMLIFrameElement | null): void => {
    if (frame === null) return;
    const frameDocument = frame.contentDocument;
    if (frameDocument === null) return;
    const base = frameDocument.createElement("base");
    base.href = "/overlay";
    // The iframe has its own document and cannot see the dashboard stylesheet, so the focus
    // outline color is read from the dashboard's own token instead of a hardcoded value; the
    // fallback is that same token's DESIGN.md value, used only if the property is unset (e.g. in tests).
    const focusOutlineColor = getComputedStyle(document.documentElement).getPropertyValue("--brand-text").trim() || "#9bc3ed";
    const baseStyle = frameDocument.createElement("style");
    baseStyle.textContent = `html,body,#root{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}body{display:grid;place-items:center}#root:focus-visible{outline:2px solid ${focusOutlineColor};outline-offset:3px}#root:active{cursor:grabbing}`;
    frameDocument.head.replaceChildren(base, baseStyle);
    const root = frameDocument.createElement("div");
    root.id = "root";
    frameDocument.body.replaceChildren(root);
    const boundsHost = frameDocument.createElement("div");
    boundsHost.dataset.brobotEditorBoundsLayer = "";
    Object.assign(boundsHost.style, { position: "fixed", inset: "0", zIndex: "2147483647", pointerEvents: "none" });
    boundsHost.attachShadow({ mode: "open" });
    frameDocument.body.appendChild(boundsHost);
    const variableStyle = frameDocument.createElement("style");
    variableStyle.textContent = variableViewCss;
    frameDocument.head.appendChild(variableStyle);
    root.setAttribute("role", "application");
    root.setAttribute("aria-label", labels.editorPreviewCanvas);
    root.tabIndex = 0;
    canvasRef.current = root;
    previewFrameRootRef.current = root;
    setPreviewFrameRoot(root);
  }, [labels.editorPreviewCanvas]);

  useLayoutEffect(() => {
    const root = previewFrameRootRef.current;
    if (root === null) return;
    root.style.position = "relative";
    root.style.width = `${String(draft.width)}px`;
    root.style.height = `${String(draft.height)}px`;
    root.style.transform = "none";
    root.style.touchAction = "none";
    root.style.cursor = "grab";
    root.style.outline = "none";
  }, [draft.height, draft.width, previewFrameRoot]);

  useLayoutEffect(() => {
    const root = previewFrameRootRef.current;
    if (root === null) return;
    let style = root.ownerDocument.querySelector<HTMLStyleElement>("style[data-brobot-overlay-css]");
    if (style === null) {
      style = root.ownerDocument.createElement("style");
      style.dataset.brobotOverlayCss = "";
      root.ownerDocument.head.appendChild(style);
    }
    style.textContent = sanitizeOverlayCss(draft.css);
  }, [draft.css, previewFrameRoot]);

  useLayoutEffect(() => {
    const root = previewFrameRootRef.current;
    if (root === null) return;
    const boundsHost = root.ownerDocument.querySelector<HTMLElement>("[data-brobot-editor-bounds-layer]");
    if (boundsHost === null) return;
    const boundsRoot = boundsHost.shadowRoot;
    if (boundsRoot === null) return;
    const mutedBoundsColor = getComputedStyle(document.documentElement).getPropertyValue("--brand-line").trim() || "#60758c";
    const selectedBoundsColor = getComputedStyle(document.documentElement).getPropertyValue("--brand-text").trim() || "#9bc3ed";
    const bounds = Array.from(root.querySelectorAll<HTMLElement>("[data-element]"), (element) => {
      const elementId = element.dataset.element;
      if (elementId === undefined) return null;
      const rect = element.getBoundingClientRect();
      const bound = root.ownerDocument.createElement("div");
      bound.className = "bound";
      bound.dataset.brobotEditorBound = elementId;
      bound.dataset.selected = String(elementId === selectedElementId);
      const selected = elementId === selectedElementId;
      Object.assign(bound.style, {
        position: "absolute", boxSizing: "border-box", pointerEvents: "none",
        left: `${String(rect.left)}px`, top: `${String(rect.top)}px`,
        width: `${String(rect.width)}px`, height: `${String(rect.height)}px`,
        border: `2px ${selected ? "solid" : "dashed"} ${selected ? selectedBoundsColor : mutedBoundsColor}`,
      });
      return bound;
    }).filter((bound): bound is HTMLDivElement => bound !== null);
    boundsRoot.replaceChildren(...bounds);
  }, [draft, liveVariables, previewFrameRoot, selectedElementId]);

  useEffect(() => {
    if (selectedElementId === null || previewFrameRoot === null) return;
    const element = findRenderedElement(previewFrameRoot, selectedElementId);
    if (element === undefined) return;
    const measure = (): void => {
      const bounds = element.getBoundingClientRect();
      setSelectedElementSize({ width: bounds.width, height: bounds.height });
    };
    const initialMeasure = window.setTimeout(measure, 0);
    if (typeof ResizeObserver === "undefined") return () => { window.clearTimeout(initialMeasure); };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      window.clearTimeout(initialMeasure);
      observer.disconnect();
    };
  }, [draft.css, previewFrameRoot, selectedElementId, selectedElementScalePercent, selectedElementText]);

  // An element hidden with `inComposition: false` is not in the DOM, so its size cannot be
  // measured; fall back to a sensible minimum instead of {0, 0} so clamping still keeps it
  // on-canvas once it is shown (a {0, 0} size would let X/Y range across the whole canvas).
  const renderedElementSize = (elementId: string): { width: number; height: number } => {
    const root = previewFrameRootRef.current;
    if (root === null) return UNMEASURED_ELEMENT_FALLBACK_SIZE;
    const element = findRenderedElement(root, elementId);
    if (element === undefined) return UNMEASURED_ELEMENT_FALLBACK_SIZE;
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  };

  const clampPosition = (element: PanelOverlayElement, x: number, y: number): { x: number; y: number } =>
    clampOverlayEditorPosition({ x, y }, canvasSize, renderedElementSize(element.id), elementHorizontalAnchor(element));

  const updateElement = useCallback((elementId: string, update: Partial<PanelOverlayElement>): void => {
    setDraft((current) => ({
      ...current,
      elements: current.elements.map((element) => element.id === elementId ? { ...element, ...update } : element),
    }));
    setSaved(false);
    setError(undefined);
  }, []);


  const writeStyleDocument = (next: OverlayStyleDocument): void => {
    setStyleDocument(next);
    const css = replaceOverlayStyleBlock(draft.css, next, draft.elements.map(({ id }) => id));
    setDraft((current) => ({ ...current, css }));
    setSaved(false);
    setError(undefined);
    setCssCopyState("idle");
  };

  const updateStyleProperty = <Key extends keyof OverlayStyle>(property: Key, value: OverlayStyle[Key] | undefined): void => {
    const current = effectiveStyleTargetId === "overlay"
      ? effectiveStyleDocument.overlay
      : effectiveStyleDocument.elements[effectiveStyleTargetId] ?? {};
    const nextTarget: OverlayStyle = Object.fromEntries(Object.entries(current).filter(([key]) => key !== property));
    if (value !== undefined) Object.assign(nextTarget, { [property]: value });
    const next: OverlayStyleDocument = effectiveStyleTargetId === "overlay"
      ? { ...effectiveStyleDocument, overlay: nextTarget }
      : {
        ...effectiveStyleDocument,
        elements: Object.keys(nextTarget).length === 0
          ? Object.fromEntries(Object.entries(effectiveStyleDocument.elements).filter(([id]) => id !== effectiveStyleTargetId))
          : { ...effectiveStyleDocument.elements, [effectiveStyleTargetId]: nextTarget },
      };
    writeStyleDocument(next);
  };

  const editCss = (css: string): void => {
    const parsed = parseOverlayStyleBlock(css);
    if (parsed.kind === "valid") setStyleDocument(parsed.styles);
    else if (parsed.kind === "missing") setStyleDocument(emptyOverlayStyles());
    setDraft((current) => ({ ...current, css }));
    setSaved(false);
    setError(undefined);
    setCssCopyState("idle");
  };

  const rewriteStylesFromEditor = (): void => {
    if (!canEdit || !styleLocked) return;
    writeStyleDocument(effectiveStyleDocument);
  };

  const resetTargetStyle = (): void => {
    if (!canEdit || styleLocked) return;
    const next: OverlayStyleDocument = effectiveStyleTargetId === "overlay"
      ? { ...effectiveStyleDocument, overlay: {} }
      : {
        ...effectiveStyleDocument,
        elements: Object.fromEntries(Object.entries(effectiveStyleDocument.elements).filter(([id]) => id !== effectiveStyleTargetId)),
      };
    writeStyleDocument(next);
  };

  const copyCss = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(draft.css);
      setCssCopyState("copied");
    } catch {
      setCssCopyState("error");
    }
  };

  const handleEditorTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const currentIndex = tabs.indexOf(event.currentTarget);
    const nextIndex = event.key === "ArrowRight" ? (currentIndex + 1) % tabs.length
      : event.key === "ArrowLeft" ? (currentIndex + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : currentIndex;
    if (nextIndex === currentIndex) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (nextTab === undefined) return;
    const name = nextTab.dataset.editorTab;
    if (name === "properties" || name === "style" || name === "css") {
      nextTab.focus();
      setEditorTab(name);
    }
  };

  const renderStyleNumber = (
    id: string,
    label: string,
    value: number | undefined,
    onChange: (next: number | undefined) => void,
    options: { min?: number; max?: number; unit?: string } = {},
  ): ReactElement => <NumberField id={id} label={label} value={value ?? ""}
    {...(options.min === undefined ? {} : { min: options.min })}
    {...(options.max === undefined ? {} : { max: options.max })}
    {...(options.unit === undefined ? {} : { unit: options.unit })}
    disabled={!canEdit || styleLocked} onChange={(next) => {
      if (typeof next !== "number") {
        onChange(undefined);
        return;
      }
      const minimum = options.min ?? Number.NEGATIVE_INFINITY;
      const maximum = options.max ?? Number.POSITIVE_INFINITY;
      onChange(Math.max(minimum, Math.min(maximum, next)));
    }} />;

  // Reclamp the selected element's position once its real rendered size is known: right after it
  // is shown (`inComposition` turned on, correcting the immediate fallback-size clamp used at
  // toggle time below) or after a scale/text/value change grows it, so it cannot stay, or become,
  // clipped off the canvas edge. A layout effect runs synchronously right after the DOM commits
  // the new render, so the measurement already reflects the change; it only writes back when the
  // clamped position actually differs, so it settles in one pass instead of looping. CSS- and
  // canvas-size-driven reclamping is handled for every element (including this one) by the
  // composition-wide effect below, so it is intentionally not a trigger here.
  useLayoutEffect(() => {
    if (selectedElement === null || !selectedElement.inComposition) return;
    const root = previewFrameRootRef.current;
    if (root === null) return;
    const element = findRenderedElement(root, selectedElement.id);
    if (element === undefined) return;
    const bounds = element.getBoundingClientRect();
    const clamped = clampOverlayEditorPosition(
      { x: selectedElement.x, y: selectedElement.y },
      { width: draft.width, height: draft.height },
      { width: bounds.width, height: bounds.height },
      selectedElementAnchor,
    );
    if (clamped.x !== selectedElement.x || clamped.y !== selectedElement.y) updateElement(selectedElement.id, clamped);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes `selectedElement`, `draft.css`/width/height (x/y change every drag frame; CSS and canvas-size reclamping is handled below for all elements).
  }, [selectedElementId, selectedElement?.inComposition, selectedElementScalePercent, selectedElementText, selectedElementLiveValue, selectedElementAnchor, previewFrameRoot, updateElement]);

  // Reclamp every composition element's position when the style CSS (or the canvas size) changes:
  // an overlay-default rule such as a larger font-size or padding can grow any element's rendered
  // box, not just the selected one, and leave an unselected element clipped near a canvas edge.
  // Measures each element's real rendered box and writes back only the elements whose clamped
  // position actually changed (via the same `updateElement` used elsewhere, so React 18 batches
  // all of them into the one re-render this effect's own dependencies then settle against), so a
  // CSS edit that grows nothing writes nothing back and cannot loop.
  useLayoutEffect(() => {
    const root = previewFrameRootRef.current;
    if (root === null) return;
    for (const element of draft.elements) {
      if (!element.inComposition) continue;
      const rendered = findRenderedElement(root, element.id);
      if (rendered === undefined) continue;
      const bounds = rendered.getBoundingClientRect();
      const clamped = clampOverlayEditorPosition(
        { x: element.x, y: element.y },
        { width: draft.width, height: draft.height },
        { width: bounds.width, height: bounds.height },
        elementHorizontalAnchor(element),
      );
      if (clamped.x !== element.x || clamped.y !== element.y) updateElement(element.id, clamped);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes `draft.elements`/`elementHorizontalAnchor` (x/y change every drag frame; only CSS- or canvas-size-driven growth should retrigger this).
  }, [draft.css, draft.width, draft.height, previewFrameRoot, updateElement]);

  const discard = useCallback((): void => {
    setDraft(baseline.draft);
    setSelectedElementId(baseline.draft.elements[0]?.id ?? null);
    setSaved(false);
    setError(undefined);
    setConflictAtRevision(null);
  }, [baseline.draft]);

  const save = useCallback(async (revision = baseline.revision): Promise<string | null> => {
    if (!canManage || saving) return labels.editorSaveError;
    if (!textIsValid) {
      setError(labels.editorTextHint);
      return labels.editorTextHint;
    }
    if (draft.css.length > 16_000) {
      setError(labels.editorStyleCssLimit);
      return labels.editorStyleCssLimit;
    }
    setSaving(true);
    setSaved(false);
    setError(undefined);
    drag.current = null;
    try {
      let saveTargetId = persistedOverlayId ?? overlayId;
      if (overlayId === "new" && persistedOverlayId === null) {
        const firstElement = draft.elements[0];
        const created = await createOverlay(channelId, {
          name: draft.name,
          width: draft.width,
          height: draft.height,
          ...(firstElement === undefined ? {} : { initialElement: saveableElement(firstElement) }),
        });
        const createdDraft = overlayDraft(created.overlay);
        saveTargetId = created.overlay.id;
        setPersistedOverlayId(created.overlay.id);
        setBaseline({ revision: created.overlay.revision, draft: createdDraft });
        onOverlayCreated(created.overlay.id);
        if (JSON.stringify(createdDraft) === JSON.stringify(draft)) {
          setDraft(createdDraft);
          setSelectedElementId((current) => createdDraft.elements.some(({ id }) => id === current) ? current : createdDraft.elements[0]?.id ?? null);
          setSaved(true);
          setConflictAtRevision(null);
          return null;
        }
        revision = created.overlay.revision;
      }
      const response = await saveOverlay(channelId, saveTargetId, revision, {
        ...draft,
        elements: draft.elements.map(saveableElement),
      });
      const nextDraft = overlayDraft(response.overlay);
      setDraft(nextDraft);
      setBaseline({ revision: response.overlay.revision, draft: nextDraft });
      setSelectedElementId((current) => nextDraft.elements.some(({ id }) => id === current) ? current : nextDraft.elements[0]?.id ?? null);
      setSaved(true);
      setConflictAtRevision(null);
      return null;
    } catch (caught) {
      if (caught instanceof PanelApiError && caught.status === 409 && caught.code === "overlay_changed_concurrently") {
        const currentRevision = conflictRevision(caught);
        if (currentRevision !== null) {
          setConflictAtRevision(currentRevision);
          return labels.editorConflictDescription;
        }
      }
      const message = caught instanceof PanelApiError ? apiErrorText(caught.code, labels.editorSaveError) : labels.editorSaveError;
      setError(message);
      return message;
    } finally {
      setSaving(false);
    }
  }, [baseline.revision, canManage, channelId, draft, labels.editorConflictDescription, labels.editorSaveError, labels.editorStyleCssLimit, labels.editorTextHint, onOverlayCreated, overlayId, persistedOverlayId, saving, textIsValid]);

  const navigationGuard = useDraftGuard(dirty, save, discard);
  useEffect(() => registerDashboardNavigationGuard(navigationGuard.guardSwitch), [navigationGuard.guardSwitch]);

  const insertVariable = (): void => {
    if (!canEdit || addVariableName.length === 0 || draft.elements.length >= OVERLAY_ELEMENT_MAXIMUM_COUNT) return;
    const element = createVariableElement(addVariableName, draft.elements);
    setDraft((current) => ({ ...current, elements: [...current.elements, element] }));
    setSelectedElementId(element.id);
    setSaved(false);
    setError(undefined);
  };

  const removeElement = (): void => {
    if (!canEdit || selectedElement === null) return;
    const remaining = draft.elements.filter(({ id }) => id !== selectedElement.id);
    setDraft((current) => ({ ...current, elements: remaining }));
    setSelectedElementId(remaining[0]?.id ?? null);
    setSaved(false);
    setError(undefined);
  };

  const moveLayer = (direction: -1 | 1): void => {
    if (!canEdit || selectedElement === null) return;
    const sorted = [...draft.elements].sort((left, right) => left.z - right.z);
    const index = sorted.findIndex(({ id }) => id === selectedElement.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= sorted.length) return;
    const [moved] = sorted.splice(index, 1);
    if (moved === undefined) return;
    sorted.splice(nextIndex, 0, moved);
    setDraft((current) => ({ ...current, elements: current.elements.map((element) => ({
      ...element,
      z: sorted.findIndex(({ id }) => id === element.id),
    })) }));
    setSaved(false);
    setError(undefined);
  };

  const moveSelected = (key: string, shift: boolean): boolean => {
    if (!canEdit || selectedElement === null) return false;
    const distance = shift ? 10 : 1;
    const requestedPosition = key === "ArrowLeft"
      ? { x: selectedElement.x - distance, y: selectedElement.y }
      : key === "ArrowRight"
        ? { x: selectedElement.x + distance, y: selectedElement.y }
        : key === "ArrowUp"
          ? { x: selectedElement.x, y: selectedElement.y - distance }
          : key === "ArrowDown"
            ? { x: selectedElement.x, y: selectedElement.y + distance }
            : null;
    if (requestedPosition === null) return false;
    const position = clampPosition(selectedElement, requestedPosition.x, requestedPosition.y);
    if (position.x !== selectedElement.x || position.y !== selectedElement.y) updateElement(selectedElement.id, position);
    return true;
  };

  const pointInCanvas = (event: PointerEvent): { x: number; y: number; scale: number } => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const scale = rect !== undefined && rect.width > 0 ? rect.width / draft.width : canvasScale;
    return {
      x: (event.clientX - (rect?.left ?? 0)) / scale,
      y: (event.clientY - (rect?.top ?? 0)) / scale,
      scale,
    };
  };

  const startDrag = (event: PointerEvent): void => {
    const elementType = canvasRef.current?.ownerDocument.defaultView?.Element;
    const target = elementType !== undefined && event.target instanceof elementType ? event.target.closest<HTMLElement>("[data-element]") : null;
    const elementId = target?.dataset.element;
    if (elementId === undefined) return;
    setSelectedElementId(elementId);
    if (!canEdit || event.button !== 0) return;
    const element = draft.elements.find(({ id }) => id === elementId);
    if (element === undefined) return;
    event.preventDefault();
    const point = pointInCanvas(event);
    drag.current = { elementId, pointerId: event.pointerId, offsetX: point.x - element.x, offsetY: point.y - element.y };
    const canvas = canvasRef.current;
    canvas?.focus();
    if (canvas !== null && typeof canvas.setPointerCapture === "function") canvas.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: PointerEvent): void => {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId || !canEdit) return;
    const point = pointInCanvas(event);
    const element = draft.elements.find(({ id }) => id === active.elementId);
    if (element === undefined) return;
    updateElement(active.elementId, clampPosition(
      element,
      point.x - active.offsetX,
      point.y - active.offsetY,
    ));
  };

  const stopDrag = (event: PointerEvent): void => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  useEffect(() => {
    previewEventHandlers.current = {
      pointerDown: startDrag,
      pointerMove: moveDrag,
      pointerUp: stopDrag,
      keyDown: (event) => { if (moveSelected(event.key, event.shiftKey)) event.preventDefault(); },
    };
  });

  useEffect(() => {
    const root = previewFrameRoot;
    if (root === null) return;
    const pointerDown = (event: PointerEvent): void => { previewEventHandlers.current.pointerDown(event); };
    const pointerMove = (event: PointerEvent): void => { previewEventHandlers.current.pointerMove(event); };
    const pointerUp = (event: PointerEvent): void => { previewEventHandlers.current.pointerUp(event); };
    const keyDown = (event: KeyboardEvent): void => { previewEventHandlers.current.keyDown(event); };
    root.addEventListener("pointerdown", pointerDown);
    root.addEventListener("pointermove", pointerMove);
    root.addEventListener("pointerup", pointerUp);
    root.addEventListener("pointercancel", pointerUp);
    root.addEventListener("lostpointercapture", pointerUp);
    root.addEventListener("keydown", keyDown);
    return () => {
      root.removeEventListener("pointerdown", pointerDown);
      root.removeEventListener("pointermove", pointerMove);
      root.removeEventListener("pointerup", pointerUp);
      root.removeEventListener("pointercancel", pointerUp);
      root.removeEventListener("lostpointercapture", pointerUp);
      root.removeEventListener("keydown", keyDown);
      if (canvasRef.current === root) canvasRef.current = null;
    };
  }, [previewFrameRoot]);

  const rendererMarkup = <OverlayCanvas overlay={rendererOverlay} language={language} variables={liveVariables} elementId={null} />;

  return <div className="overlay-editor">
    <header className="overlay-editor__header">
      <Button variant="subtle" disabled={saving} onClick={onBack}>{labels.editorBack}</Button>
      <div><h1>{overlay.name}</h1><span className="muted">{labels.editorReference(draft.width, draft.height)}</span></div>
    </header>
    <div className="overlay-editor__workspace">
      <section className="overlay-editor__elements" aria-label={labels.editorElements}>
        <div className="overlay-editor__section-heading"><h2>{labels.editorElements}</h2><span className="muted">{draft.elements.length} / {String(OVERLAY_ELEMENT_MAXIMUM_COUNT)}</span></div>
        {orderedElements.length === 0 ? <p className="muted">{labels.editorNoElements}</p> : <ul className="overlay-editor__element-list">
          {orderedElements.map((element) => <li key={element.id}>
            <button type="button" aria-pressed={element.id === selectedElementId} onClick={() => { setSelectedElementId(element.id); }}>
              <span>{element.label || element.variableName || labels.editorVariable}</span>
              <small>{element.variableName ?? element.missingVariableName ?? "—"}</small>
            </button>
          </li>)}
        </ul>}
        <div className="overlay-editor__add-element">
          <DisabledFieldReasonContext.Provider value={canManage ? null : { id: "overlay-editor-readonly-reason", reason: labels.editorReadOnly }}>
            <Select id="overlay-editor-variable" label={labels.editorChooseVariable} value={addVariableName || null}
              disabled={!canEdit || variables.length === 0 || draft.elements.length >= OVERLAY_ELEMENT_MAXIMUM_COUNT}
              {...(canManage ? {} : { title: labels.editorReadOnly, describedBy: "overlay-editor-readonly-reason" })}
              options={variables.map(({ name }) => ({ value: name, label: name }))}
              onChange={(value) => { if (value !== null) setChosenVariableName(value); }} />
          </DisabledFieldReasonContext.Provider>
          <Button variant="neutral" disabled={!canEdit || variables.length === 0 || draft.elements.length >= OVERLAY_ELEMENT_MAXIMUM_COUNT}
            {...(canManage ? {} : { title: labels.editorReadOnly, describedBy: "overlay-editor-readonly-reason" })}
            onClick={insertVariable}>{labels.editorAddVariable}</Button>
          {draft.elements.length >= OVERLAY_ELEMENT_MAXIMUM_COUNT ? <p className="form-hint">{labels.editorElementLimit}</p> : null}
        </div>
      </section>

      <section className="overlay-editor__preview-panel" aria-label={labels.editorPreview}>
        <div className="overlay-editor__section-heading"><h2>{labels.editorPreview}</h2>
          <div className="overlay-editor__zoom">
            <NumberField id="overlay-editor-zoom" label={labels.editorZoom} value={previewZoom} min={60} max={200} unit="%"
              onChange={(value) => { if (typeof value === "number") setPreviewZoom(Math.max(60, Math.min(200, Math.round(value / 10) * 10))); }} />
          </div>
        </div>
        <div className="overlay-editor__preview-viewport" ref={previewViewportRef}
          style={{ aspectRatio: `${String(draft.width)} / ${String(draft.height)}` }}>
          <div className="overlay-editor__canvas-frame" style={{ width: draft.width * canvasScale, height: draft.height * canvasScale }}>
            <iframe className="overlay-editor__preview-frame" data-testid="overlay-editor-renderer"
              title={labels.editorPreviewCanvas} sandbox="allow-same-origin"
              style={{ width: draft.width, height: draft.height, transform: `translate(-50%, -50%) scale(${String(canvasScale)})` }}
              ref={loadPreviewFrame} />
            {previewFrameRoot === null ? null : createPortal(rendererMarkup, previewFrameRoot)}
          </div>
        </div>
        <div className="overlay-editor__preview-foot"><span>{labels.editorReference(draft.width, draft.height)}</span><span>{labels.editorZoom}: 60–200%</span></div>
      </section>

      <section className="overlay-editor__properties" aria-label={labels.editorProperties}>
        <div className="overlay-editor__section-heading"><h2>{labels.editorProperties}</h2></div>
        <div className="overlay-editor__editor-tabs" role="tablist" aria-label={labels.editorProperties}>
          <button type="button" role="tab" id="overlay-editor-tab-properties" data-editor-tab="properties" tabIndex={editorTab === "properties" ? 0 : -1}
            aria-selected={editorTab === "properties"} aria-controls="overlay-editor-panel-properties" onKeyDown={handleEditorTabKeyDown}
            aria-label={labels.editorPropertiesTab} onClick={() => { setEditorTab("properties"); }}><Icon name="tabSettings" size={16} /><span>{labels.editorPropertiesTabShort}</span></button>
          <button type="button" role="tab" id="overlay-editor-tab-style" data-editor-tab="style" tabIndex={editorTab === "style" ? 0 : -1}
            aria-selected={editorTab === "style"} aria-controls="overlay-editor-panel-style" onKeyDown={handleEditorTabKeyDown}
            aria-label={labels.editorStyleTab} onClick={() => { setEditorTab("style"); }}><Icon name="tabAdvanced" size={16} /><span>{labels.editorStyleTabShort}</span></button>
          <button type="button" role="tab" id="overlay-editor-tab-css" data-editor-tab="css" tabIndex={editorTab === "css" ? 0 : -1}
            aria-selected={editorTab === "css"} aria-controls="overlay-editor-panel-css" onKeyDown={handleEditorTabKeyDown}
            aria-label={labels.editorCssTab} onClick={() => { setEditorTab("css"); }}><Icon name="tabCode" size={16} /><span>{labels.editorCssTabShort}</span></button>
        </div>
        <div role="tabpanel" id="overlay-editor-panel-properties" aria-labelledby="overlay-editor-tab-properties" hidden={editorTab !== "properties"}>
        {initialNotice === null ? null : <p className="form-error" role="alert">{initialNotice.kind === "element-limit" ? labels.editorElementLimit : labels.editorMissingPrefill(initialNotice.name)}</p>}
        {selectedElement === null ? <p className="muted">{labels.editorNoSelection}</p> : <div className="overlay-editor__property-fields">
          {selectedElement.variableName === null
            ? <p className="muted" role="note">{selectedElement.missingVariableName === undefined || selectedElement.missingVariableName === null
              ? labels.editorVariable
              : labels.missingVariable(selectedElement.missingVariableName)}</p>
            : <Field id="overlay-editor-variable-name" label={labels.editorVariable} value={selectedElement.variableName} readOnly onChange={() => undefined} />}
          <Field id="overlay-editor-label" label={labels.editorLabel} value={selectedElement.label} maxLength={40}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={!canEdit}
            onChange={(label) => { updateElement(selectedElement.id, { label }); }} />
          <Field id="overlay-editor-text" label={labels.editorDisplayText} hint={labels.editorTextHint} value={selectedElement.text} maxLength={100}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={!canEdit}
            onChange={(text) => { updateElement(selectedElement.id, { text }); }} />
          <div className="overlay-editor__numeric-fields">
            <NumberField id="overlay-editor-x" label={labels.editorX} min={selectedPositionLimits.minX} max={selectedPositionLimits.x} value={selectedElement.x} disabled={!canEdit}
              onChange={(x) => { if (typeof x === "number") updateElement(selectedElement.id, clampPosition(selectedElement, x, selectedElement.y)); }} />
            <NumberField id="overlay-editor-y" label={labels.editorY} min={0} max={selectedPositionLimits.y} value={selectedElement.y} disabled={!canEdit}
              onChange={(y) => { if (typeof y === "number") updateElement(selectedElement.id, clampPosition(selectedElement, selectedElement.x, y)); }} />
            <NumberField id="overlay-editor-scale" label={labels.editorScale} min={25} max={400} value={selectedElement.scalePercent} disabled={!canEdit}
              onChange={(scalePercent) => { if (typeof scalePercent === "number") updateElement(selectedElement.id, { scalePercent: Math.max(25, Math.min(400, Math.round(scalePercent))) }); }} />
            <NumberField id="overlay-editor-z" label={labels.editorZ} value={selectedElement.z} disabled={!canEdit}
              onChange={(z) => { if (typeof z === "number") updateElement(selectedElement.id, { z: Math.round(z) }); }} />
          </div>
          <div className="overlay-editor__layer-actions">
            <Button variant="neutral" disabled={!canEdit || orderedElements[0]?.id === selectedElement.id} onClick={() => { moveLayer(1); }}>{labels.editorMoveForward}</Button>
            <Button variant="neutral" disabled={!canEdit || orderedElements.at(-1)?.id === selectedElement.id} onClick={() => { moveLayer(-1); }}>{labels.editorMoveBackward}</Button>
          </div>
          <Switch layout="inline" label={labels.editorInComposition} checked={selectedElement.inComposition} disabled={!canEdit}
            onChange={(inComposition) => { updateElement(selectedElement.id, inComposition
              ? { inComposition, ...clampPosition(selectedElement, selectedElement.x, selectedElement.y) }
              : { inComposition }); }} />
          <Button danger="subtle" disabled={!canEdit}
            {...(canManage ? {} : { title: labels.editorReadOnly, describedBy: "overlay-editor-readonly-reason" })}
            onClick={removeElement}>{labels.editorRemove}</Button>
        </div>}
        {!canManage ? <p className="muted" id="overlay-editor-readonly-reason" role="note">{labels.editorReadOnly}</p> : null}
        </div>
        <div role="tabpanel" id="overlay-editor-panel-style" aria-labelledby="overlay-editor-tab-style" hidden={editorTab !== "style"}>
          <DisabledFieldReasonContext.Provider value={styleLockedReason.length === 0 ? null : { id: "overlay-style-disabled-reason", reason: styleLockedReason }}>
            <div className="overlay-editor__style-fields">
              <Select id="overlay-editor-style-target" label={labels.editorStyleTarget} value={effectiveStyleTargetId}
                options={[
                  { value: "overlay", label: labels.editorStyleOverlayTarget },
                  ...draft.elements.map((element) => ({ value: element.id, label: labels.editorStyleElementTarget(element.label || element.variableName || element.id) })),
                ]}
                onChange={(value) => { if (value !== null) setStyleTargetId(value); }} />
              {!canManage ? <p className="muted" id="overlay-style-disabled-reason" role="note">{labels.editorStyleReadOnlyReason}</p> : null}
              <p className="form-hint">{labels.editorStyleOwnCssHint}</p>
              {styleLocked ? <div className="overlay-editor__style-lock" role="status">
                <p {...(canManage ? { id: "overlay-style-disabled-reason" } : {})}>{labels.editorStyleLocked}</p>
                <Button variant="neutral" disabled={!canEdit || parsedStyleBlock.contentStart === null}
                  {...(canManage ? {} : { title: labels.editorStyleReadOnlyReason, describedBy: "overlay-style-disabled-reason" })}
                  onClick={rewriteStylesFromEditor}>{labels.editorStyleRewrite}</Button>
              </div> : null}
              <StyleDisclosureSection key={`${effectiveStyleTargetId}:font`} section="font" icon="styleFont" title={labels.editorStyleFontSection}
                summary={styleSectionSummary(targetStyle, "font", labels.editorStyleSectionUnset, labels.editorStyleLeft, labels.editorStyleCenter, labels.editorStyleRight)} defaultExpanded>
                <div className="overlay-editor__style-grid">
                  <div className="overlay-editor__style-pair">
                    <Select id="overlay-editor-style-system-font" label={labels.editorStyleFontSystem}
                      value={SYSTEM_FONT_FAMILIES.includes(targetStyle.fontFamily as (typeof SYSTEM_FONT_FAMILIES)[number]) ? targetStyle.fontFamily ?? null : null}
                      disabled={!canEdit || styleLocked}
                      {...(styleLockedReason.length === 0 ? {} : { describedBy: "overlay-style-disabled-reason" })}
                      options={SYSTEM_FONT_FAMILIES.map((fontFamily) => ({ value: fontFamily, label: fontFamily }))}
                      onChange={(value) => { if (value !== null) updateStyleProperty("fontFamily", value); }} />
                    <Field id="overlay-editor-style-font-family" label={labels.editorStyleFontFamily} hint={labels.editorStyleFontCustomHint}
                      value={targetStyle.fontFamily ?? ""} maxLength={80}
                      countLabel={labels.editorStyleFontFamilyCount}
                      disabled={!canEdit || styleLocked} onChange={(value) => { updateStyleProperty("fontFamily", value.length === 0 ? undefined : value); }} />
                  </div>
                  <div className="overlay-editor__style-pair">
                    {renderStyleNumber("overlay-editor-style-font-size", labels.editorStyleFontSize, targetStyle.fontSize,
                      (value) => { updateStyleProperty("fontSize", value); }, { min: 1, max: 500, unit: "px" })}
                    <Select id="overlay-editor-style-font-weight" label={labels.editorStyleFontWeight}
                      value={targetStyle.fontWeight === undefined ? null : String(targetStyle.fontWeight)} disabled={!canEdit || styleLocked}
                      {...(styleLockedReason.length === 0 ? {} : { describedBy: "overlay-style-disabled-reason" })}
                      options={[400, 500, 600, 700].map((weight) => ({ value: String(weight), label: String(weight) }))}
                      onChange={(value) => { updateStyleProperty("fontWeight", value === null ? undefined : Number(value) as 400 | 500 | 600 | 700); }} />
                  </div>
                  <div className="overlay-editor__style-pair">
                    <ColorField id="overlay-editor-style-color" label={labels.editorStyleColor} value={targetStyle.color}
                      unsetLabel={labels.editorStyleColorUnset} clearLabel={labels.editorStyleColorClear} disabled={!canEdit || styleLocked}
                      onChange={(value) => { updateStyleProperty("color", value); }} />
                    <Select id="overlay-editor-style-alignment" label={labels.editorStyleAlignment} hint={labels.editorStyleAlignmentHint}
                      value={targetStyle.textAlign ?? null} disabled={!canEdit || styleLocked}
                      {...(styleLockedReason.length === 0 ? {} : { describedBy: "overlay-style-disabled-reason" })}
                      options={[
                        { value: "left", label: labels.editorStyleLeft },
                        { value: "center", label: labels.editorStyleCenter },
                        { value: "right", label: labels.editorStyleRight },
                      ]}
                      onChange={(value) => { updateStyleProperty("textAlign", value === "left" || value === "center" || value === "right" ? value : undefined); }} />
                  </div>
                  <div className="overlay-editor__style-pair">
                    {renderStyleNumber("overlay-editor-style-line-height", labels.editorStyleLineHeight, targetStyle.lineHeight,
                      (value) => { updateStyleProperty("lineHeight", value); }, { min: 0.5, max: 3 })}
                    {renderStyleNumber("overlay-editor-style-letter-spacing", labels.editorStyleLetterSpacing, targetStyle.letterSpacing,
                      (value) => { updateStyleProperty("letterSpacing", value); }, { min: -100, max: 100, unit: "px" })}
                  </div>
                </div>
              </StyleDisclosureSection>
              <StyleDisclosureSection key={`${effectiveStyleTargetId}:outline`} section="outline" icon="styleOutline" title={labels.editorStyleOutlineSection}
                summary={styleSectionSummary(targetStyle, "outline", labels.editorStyleSectionUnset, labels.editorStyleLeft, labels.editorStyleCenter, labels.editorStyleRight)} defaultExpanded={styleSectionHasValues(targetStyle, "outline")}>
                <div className="overlay-editor__style-grid">
                  <div className="overlay-editor__style-pair">
                    {renderStyleNumber("overlay-editor-style-stroke-width", labels.editorStyleStrokeWidth, targetStyle.stroke?.width,
                      (value) => { updateStyleProperty("stroke", value === undefined ? undefined : { width: value, color: targetStyle.stroke?.color ?? "#000000" }); }, { min: 0.1, max: 20, unit: "px" })}
                    <ColorField id="overlay-editor-style-stroke-color" label={labels.editorStyleStrokeColor} value={targetStyle.stroke?.color}
                      unsetLabel={labels.editorStyleColorUnset} clearLabel={labels.editorStyleColorClear} disabled={!canEdit || styleLocked}
                      onChange={(value) => { updateStyleProperty("stroke", value === undefined ? undefined : { width: targetStyle.stroke?.width ?? 2, color: value }); }} />
                  </div>
                </div>
              </StyleDisclosureSection>
              <StyleDisclosureSection key={`${effectiveStyleTargetId}:shadow`} section="shadow" icon="styleShadow" title={labels.editorStyleShadowSection}
                summary={styleSectionSummary(targetStyle, "shadow", labels.editorStyleSectionUnset, labels.editorStyleLeft, labels.editorStyleCenter, labels.editorStyleRight)} defaultExpanded={styleSectionHasValues(targetStyle, "shadow")}>
                <div className="overlay-editor__style-grid">
                  <div className="overlay-editor__style-pair overlay-editor__style-pair--triple">
                    {renderStyleNumber("overlay-editor-style-shadow-x", labels.editorStyleShadowX, targetStyle.shadow?.x,
                      (value) => { updateStyleProperty("shadow", value === undefined ? undefined : { ...targetStyle.shadow, x: value, y: targetStyle.shadow?.y ?? 2, blur: targetStyle.shadow?.blur ?? 4, color: targetStyle.shadow?.color ?? "#000000" }); }, { min: -100, max: 100, unit: "px" })}
                    {renderStyleNumber("overlay-editor-style-shadow-y", labels.editorStyleShadowY, targetStyle.shadow?.y,
                      (value) => { updateStyleProperty("shadow", value === undefined ? undefined : { ...targetStyle.shadow, x: targetStyle.shadow?.x ?? 0, y: value, blur: targetStyle.shadow?.blur ?? 4, color: targetStyle.shadow?.color ?? "#000000" }); }, { min: -100, max: 100, unit: "px" })}
                    {renderStyleNumber("overlay-editor-style-shadow-blur", labels.editorStyleShadowBlur, targetStyle.shadow?.blur,
                      (value) => { updateStyleProperty("shadow", value === undefined ? undefined : { ...targetStyle.shadow, x: targetStyle.shadow?.x ?? 0, y: targetStyle.shadow?.y ?? 2, blur: value, color: targetStyle.shadow?.color ?? "#000000" }); }, { min: 0, max: 100, unit: "px" })}
                  </div>
                  <ColorField id="overlay-editor-style-shadow-color" label={labels.editorStyleShadowColor} value={targetStyle.shadow?.color}
                    unsetLabel={labels.editorStyleColorUnset} clearLabel={labels.editorStyleColorClear} disabled={!canEdit || styleLocked}
                    onChange={(value) => { updateStyleProperty("shadow", value === undefined ? undefined : { x: targetStyle.shadow?.x ?? 0, y: targetStyle.shadow?.y ?? 2, blur: targetStyle.shadow?.blur ?? 4, color: value }); }} />
                </div>
              </StyleDisclosureSection>
              <StyleDisclosureSection key={`${effectiveStyleTargetId}:background`} section="background" icon="styleBackground" title={labels.editorStyleBackgroundSection}
                summary={styleSectionSummary(targetStyle, "background", labels.editorStyleSectionUnset, labels.editorStyleLeft, labels.editorStyleCenter, labels.editorStyleRight)} defaultExpanded={styleSectionHasValues(targetStyle, "background")}>
                <div className="overlay-editor__style-grid">
                  <div className="overlay-editor__style-pair">
                    <ColorField id="overlay-editor-style-background-color" label={labels.editorStyleBackgroundColor} value={targetStyle.background?.color}
                      unsetLabel={labels.editorStyleColorUnset} clearLabel={labels.editorStyleColorClear} disabled={!canEdit || styleLocked}
                      onChange={(value) => { updateStyleProperty("background", value === undefined ? undefined : { color: value, opacityPercent: targetStyle.background?.opacityPercent ?? 100 }); }} />
                    {renderStyleNumber("overlay-editor-style-background-opacity", labels.editorStyleBackgroundOpacity, targetStyle.background?.opacityPercent,
                      (value) => { updateStyleProperty("background", value === undefined ? undefined : { color: targetStyle.background?.color ?? "#000000", opacityPercent: Math.round(Math.max(0, Math.min(100, value))) }); }, { min: 0, max: 100, unit: "%" })}
                  </div>
                  <div className="overlay-editor__style-pair">
                    {renderStyleNumber("overlay-editor-style-padding", labels.editorStylePadding, targetStyle.padding,
                      (value) => { updateStyleProperty("padding", value); }, { min: 0, max: 100, unit: "px" })}
                    {renderStyleNumber("overlay-editor-style-radius", labels.editorStyleRadius, targetStyle.borderRadius,
                      (value) => { updateStyleProperty("borderRadius", value); }, { min: 0, max: 100, unit: "px" })}
                  </div>
                </div>
              </StyleDisclosureSection>
              <div className="overlay-editor__style-actions">
                <Button variant="neutral" disabled={!canEdit || styleLocked}
                  {...(canManage ? {} : { title: labels.editorStyleReadOnlyReason, describedBy: "overlay-style-disabled-reason" })}
                  onClick={resetTargetStyle}>{labels.editorStyleReset}</Button>
              </div>
            </div>
          </DisabledFieldReasonContext.Provider>
        </div>
        <div role="tabpanel" id="overlay-editor-panel-css" aria-labelledby="overlay-editor-tab-css" hidden={editorTab !== "css"}>
          <div className="overlay-editor__code-actions">
            <p className="form-hint">{labels.editorStyleCodeHint}</p>
            <Button variant="neutral" onClick={() => { void copyCss(); }}>{labels.editorStyleCopy}</Button>
          </div>
          {cssCopyState === "copied" ? <p className="form-hint" role="status">{labels.editorStyleCopied}</p> : null}
          {cssCopyState === "error" ? <p className="form-error" role="alert">{labels.editorStyleCopyError}</p> : null}
          {!canManage ? <p className="muted" id="overlay-editor-css-readonly-reason" role="note">{labels.editorCssReadOnlyReason}</p> : null}
          <DisabledFieldReasonContext.Provider value={!canManage ? { id: "overlay-editor-css-disabled-reason", reason: labels.editorCssReadOnlyReason } : null}>
            <CodeField id="overlay-editor-css-code" className="overlay-editor__css-code" label={labels.editorCssTab} value={draft.css} maxLength={16000}
              disabled={!canEdit} onChange={editCss} />
          </DisabledFieldReasonContext.Provider>
        </div>
      </section>
    </div>

    <SaveBar dirty={dirty} pending={saving} saved={saved} persistent
      {...(error === undefined ? {} : { error })}
      invalid={!textIsValid || draft.css.length > 16_000}
      invalidMessage={textIsValid ? labels.editorStyleCssLimit : labels.editorTextHint}
      warnings={dirty ? [labels.editorUnsaved] : []}
      warningStatusLabel={(_warnings, justSaved) => justSaved ? labels.editorSaved : labels.editorUnsaved}
      // The status line already shows the "unsaved"/"saved" message (via `warnings`/`warningStatusLabel`
      // above); the footer would otherwise repeat the exact same text next to the buttons. Only the
      // clean, no-changes-yet state has nothing on the status line, so the footer fills that gap instead
      // of duplicating it.
      {...(dirty || saved ? {} : { footer: labels.editorClean })}
      {...(canManage ? {} : { saveDescribedBy: "overlay-editor-readonly-reason", saveTitle: labels.editorReadOnly })}
      onSave={() => { void save(); }} onDiscard={discard}
      saveLabel={labels.editorSave} discardLabel={labels.editorDiscard} savedLabel={labels.editorSaved} pendingLabel={labels.editorSaving} />

    <ConfirmDialog opened={navigationGuard.confirmOpen} title={labels.editorUnsavedTitle}
      description={navigationGuard.saveError ?? labels.editorUnsavedDescription}
      cancelLabel={labels.editorContinue} confirmLabel={labels.editorDiscardAndLeave}
      onCancel={navigationGuard.continueEditing} onConfirm={navigationGuard.discardAndSwitch}
      {...(dirty && canManage && conflictAtRevision === null ? { alternative: { label: labels.editorSaveAndLeave, onClick: () => { void navigationGuard.saveAndSwitch(); } } } : {})}
      pending={navigationGuard.saving || saving} danger />
    <ConfirmDialog opened={conflictAtRevision !== null && !navigationGuard.confirmOpen} title={labels.editorConflictTitle}
      description={labels.editorConflictDescription} cancelLabel={labels.editorConflictKeep} confirmLabel={labels.editorConflictOverwrite}
      onCancel={() => { setConflictAtRevision(null); setError(labels.editorConflictDescription); }}
      onConfirm={() => { if (conflictAtRevision !== null) void save(conflictAtRevision); }}
      alternative={{ label: labels.editorConflictReload, onClick: onReload }} pending={saving} />
  </div>;
}
