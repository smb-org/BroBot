import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { OVERLAY_ELEMENT_MAXIMUM_COUNT } from "../contracts/values";
import { sanitizeOverlayCss } from "../contracts/overlay-css";
import type { PanelModuleState } from "../panel-contract";
import { OverlayCanvas } from "../overlay/canvas";
import type { BoundOverlayData, OverlayLanguage } from "../overlay/model";
import { MODULE_OVERLAY_ELEMENTS } from "../modules/overlay-element-registry";
import { MODULE_NAVIGATION_CATEGORIES, type JsonObject, type ModuleNavigationCategory, type ModuleOverlayElementDefinition } from "../modules/contract";
import { MODULES } from "../modules/registry";
import { ModuleOverlayElementEditor } from "./ModuleOverlayElementEditor";
import { ModuleIcon } from "./module-panels";
import variableViewCss from "../overlay/variable.css?inline";
import { clampOverlayEditorPosition, overlayEditorMeasuredSize, UNMEASURED_ELEMENT_FALLBACK_SIZE, type OverlayEditorSize } from "./overlay-editor-model";
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
  fetchModules,
  fetchOverlay,
  PanelApiError,
  saveOverlay,
  type PanelChannelVariable,
  type PanelOverlay,
  type PanelOverlayDraft,
  type PanelOverlayElement,
} from "./api";
import { apiErrorText, channelVariablesTexts, dashboardLanguage, dashboardTexts, formatNumber, overlaysTexts } from "./locale";
import { moduleName } from "./module-labels";
import { OverlayElementPalette, type OverlayElementPaletteOption } from "./OverlayElementPalette";
import { useRealtimeVariableUpdates } from "./realtime";
import { Button, CodeField, ColorField, ConfirmDialog, Field, Icon, LoadState, NumberField, PageHeader, SaveBar, Select, Switch, notify, type IconName, registerDashboardNavigationGuard, useDraftGuard } from "./ui";
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
  moduleStates: readonly PanelModuleState[];
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

type EditorJsonValue = string | number | boolean | null | readonly EditorJsonValue[] | { readonly [key: string]: EditorJsonValue };
type EditorJsonObject = Readonly<Record<string, EditorJsonValue>>;

interface ModuleElementOption {
  kind: `${string}.${string}`;
  moduleId: string;
  navigationCategory: ModuleNavigationCategory;
  defaultSize: { width: number; height: number };
  defaultConfig: EditorJsonObject;
  previewState?: ModuleOverlayElementDefinition["previewState"];
  parseConfig: (raw: unknown) => EditorJsonObject | null;
  description: (language: "de" | "en") => string;
  label: (language: "de" | "en") => string;
  moduleName: (language: "de" | "en") => string;
}

const MODULE_ELEMENT_OPTIONS: readonly ModuleElementOption[] = MODULE_OVERLAY_ELEMENTS.map(({ moduleId, definition }) => {
  const module = MODULES.find((candidate) => candidate.id === moduleId);
  return {
    kind: definition.kind,
    moduleId,
    navigationCategory: module?.navigationCategory ?? MODULE_NAVIGATION_CATEGORIES[0],
    defaultSize: definition.defaultSize,
    defaultConfig: definition.defaultConfig,
    ...(definition.previewState === undefined ? {} : { previewState: definition.previewState }),
    parseConfig: definition.parseConfig,
    description: (language) => definition.editorDescription?.[language] ?? "",
    label: (language) => definition.editorLabel?.[language] ?? definition.kind,
    moduleName: (language) => definition.editorModuleLabel?.[language] ?? moduleName(moduleId, language),
  };
});

const moduleElementOption = (kind: string): ModuleElementOption | undefined =>
  MODULE_ELEMENT_OPTIONS.find((option) => option.kind === kind);

const createModuleElement = (
  option: ModuleElementOption,
  elements: readonly PanelOverlayElement[],
  width: number,
  height: number,
): PanelOverlayElement => ({
  id: crypto.randomUUID(),
  kind: option.kind,
  label: option.label(dashboardLanguage()),
  variableName: null,
  text: "",
  config: option.defaultConfig,
  x: Math.max(0, Math.floor((width - option.defaultSize.width) / 2)),
  y: Math.max(0, Math.floor((height - option.defaultSize.height) / 2)),
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
  const dashboardLocale = dashboardLanguage();
  const labels = useMemo(() => overlaysTexts(dashboardLocale), [dashboardLocale]);
  const [variables, setVariables] = useState<readonly PanelChannelVariable[]>([]);
  const [moduleStates, setModuleStates] = useState<readonly PanelModuleState[]>([]);
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
    const moduleRequest = fetchModules(channelId).catch(() => ({ modules: [] }));
    void Promise.all([overlayRequest, fetchChannelVariables(channelId), moduleRequest])
      .then(([overlayResult, variableResult, moduleResult]) => {
        if (disposed) return;
        setVariables(variableResult.variables);
        setModuleStates(moduleResult.modules);
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
        const message = caught instanceof PanelApiError
          ? apiErrorText(caught.code, labels.editorLoadError)
          : labels.editorLoadError;
        setLoadError(message);
        notify({ tone: "error", message });
      });
    return () => { disposed = true; };
  }, [channelId, initialOverlayName, labels.editorLoadError, loadGeneration, overlayId]);

  const reload = useCallback((): void => {
    setSession(null);
    setLoadError(null);
    setLoadGeneration((current) => current + 1);
  }, []);

  if (loadError !== null || session === null) return <section className="overlay-editor overlay-editor--message">
    <Button variant="subtle" onClick={onBack}>{labels.editorBack}</Button>
    <LoadState status={loadError === null ? "loading" : "error"} minHeight="360px"
      loading={<p className="loading-line">{labels.editorLoading}</p>}
      empty={<span />}
      error={<Button variant="neutral" onClick={reload}>{labels.editorConflictReload}</Button>}>
      {null}
    </LoadState>
  </section>;

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
    moduleStates={moduleStates}
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
  moduleStates,
  liveVariables,
  onBack,
  onReload,
  onOverlayCreated,
}: OverlayEditorWorkspaceProperties): ReactElement {
  const dashboardLocale = dashboardLanguage();
  const labels = useMemo(() => overlaysTexts(dashboardLocale), [dashboardLocale]);
  const moduleIsEnabled = (moduleId: string): boolean => {
    const module = moduleStates.find((candidate) => candidate.id === moduleId);
    return module?.mandatory === true || module?.enabled === true;
  };
  const [draft, setDraft] = useState(initialDraft);
  const [baseline, setBaseline] = useState<OverlayDraftBaseline>({ revision: overlay.revision, draft: baseDraft });
  const [selectedElementId, setSelectedElementId] = useState(initialElementId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [conflictAtRevision, setConflictAtRevision] = useState<number | null>(null);
  const [persistedOverlayId, setPersistedOverlayId] = useState<string | null>(null);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [modulePreviewStates, setModulePreviewStates] = useState<Readonly<Record<string, JsonObject>>>({});
  const [editorTab, setEditorTab] = useState<"properties" | "style" | "css">("properties");
  const [styleTargetId, setStyleTargetId] = useState("overlay");
  const [styleDocument, setStyleDocument] = useState<OverlayStyleDocument>(() => {
    const parsed = parseOverlayStyleBlock(overlay.css);
    return parsed.kind === "valid" ? parsed.styles : emptyOverlayStyles();
  });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [previewFrameRoot, setPreviewFrameRoot] = useState<HTMLDivElement | null>(null);
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
  const initialNoticeMessage = initialNotice === null
    ? null
    : initialNotice.kind === "element-limit"
      ? labels.editorElementLimit
      : labels.editorMissingPrefill(initialNotice.name);

  useEffect(() => {
    if (initialNoticeMessage !== null) notify({ tone: "error", message: initialNoticeMessage });
  }, [initialNoticeMessage]);

  const canEdit = canManage && !saving;
  const selectedElement = draft.elements.find((element) => element.id === selectedElementId) ?? null;
  const updateSelectedPreviewState = useCallback((state: JsonObject | null): void => {
    if (selectedElementId === null) return;
    setModulePreviewStates((current) => {
      if (state === null) {
        return Object.fromEntries(Object.entries(current).filter(([id]) => id !== selectedElementId));
      }
      return { ...current, [selectedElementId]: state };
    });
  }, [selectedElementId]);
  const selectedModuleOption = selectedElement === null ? undefined : moduleElementOption(selectedElement.kind);
  const orderedElements = useMemo(() => [...draft.elements].sort((left, right) => right.z - left.z), [draft.elements]);
  const paletteItems: OverlayElementPaletteOption[] = [
    ...variables.map(({ name, description, value }) => ({
      id: `variable:${name}`,
      groupId: "variables" as const,
      label: name,
      description: description.trim().length > 0 ? description : channelVariablesTexts(dashboardLocale).noDescription,
      variableName: name,
      currentValue: formatNumber(liveVariables[name] ?? value),
      icon: <Icon name="variable" size={20} />,
    })),
    ...MODULE_ELEMENT_OPTIONS.map((option) => {
      const name = option.moduleName(language);
      const enabled = moduleIsEnabled(option.moduleId);
      return {
        id: `module:${option.kind}`,
        groupId: option.navigationCategory,
        label: option.label(language),
        description: option.description(language),
        moduleName: name,
        ...(enabled ? {} : { disabledReason: labels.editorPaletteModuleOff(name) }),
        icon: <ModuleIcon moduleId={option.moduleId} className="overlay-element-palette__icon" />,
      };
    }),
  ];
  const previewNow = Date.parse(new Date().toISOString());
  const rendererOverlay: BoundOverlayData = {
    id: overlayId,
    revision: baseline.revision,
    width: draft.width,
    height: draft.height,
    css: draft.css,
    elements: draft.elements.map((element) => {
      const option = moduleElementOption(element.kind);
      if (option === undefined) return element;
      const enabled = moduleIsEnabled(option.moduleId);
      return {
        ...element,
        moduleEnabled: enabled,
        state: modulePreviewStates[element.id] ?? option.previewState?.(
          option.parseConfig(element.config) ?? option.defaultConfig,
          language,
          previewNow,
        ) ?? null,
      };
    }),
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
  const styleLockedReason = !canManage ? labels.editorStyleReadOnlyReason : styleLocked ? labels.editorStyleLocked : "";
  const fitScale = viewportSize.width === 0 || viewportSize.height === 0
    ? 1
    : Math.min(viewportSize.width / draft.width, viewportSize.height / draft.height);
  const canvasScale = fitScale * previewZoom / 100;
  const textIsValid = draft.elements.every((element) => element.kind !== "variable" || element.text.match(/\{value\}/gu)?.length === 1);
  const canvasSize = { width: draft.width, height: draft.height };
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

  // Hidden elements have no rendered size, so pointer-drag clamping uses their declared default
  // size or a small fallback.
  const measuredRenderedElementSize = (elementId: string): OverlayEditorSize | null => {
    const root = previewFrameRootRef.current;
    if (root === null) return null;
    const element = findRenderedElement(root, elementId);
    if (element === undefined) return null;
    const bounds = element.getBoundingClientRect();
    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) return null;
    return { width: bounds.width, height: bounds.height };
  };

  // The fallback is the unscaled (100%) size; measured sizes already include the element's scale.
  const unscaledFallbackSize = (elementId: string): OverlayEditorSize => {
    const draftElement = draft.elements.find(({ id }) => id === elementId);
    return draftElement === undefined
      ? UNMEASURED_ELEMENT_FALLBACK_SIZE
      : moduleElementOption(draftElement.kind)?.defaultSize ?? UNMEASURED_ELEMENT_FALLBACK_SIZE;
  };

  const renderedElementSize = (elementId: string): OverlayEditorSize => {
    const fallback = unscaledFallbackSize(elementId);
    return overlayEditorMeasuredSize(measuredRenderedElementSize(elementId) ?? { width: 0, height: 0 }, fallback);
  };

  const clampDraggedPosition = (element: PanelOverlayElement, x: number, y: number): { x: number; y: number } =>
    clampOverlayEditorPosition({ x, y }, canvasSize, renderedElementSize(element.id), elementHorizontalAnchor(element));

  // User scale input may move the element: keep the scaled box inside the canvas.
  const scaleElement = (element: PanelOverlayElement, scalePercent: number): void => {
    const measured = measuredRenderedElementSize(element.id);
    const fallback = unscaledFallbackSize(element.id);
    const factor = measured === null ? scalePercent / 100 : scalePercent / element.scalePercent;
    const base = measured ?? fallback;
    updateElement(element.id, {
      scalePercent,
      ...clampOverlayEditorPosition({ x: element.x, y: element.y }, canvasSize, { width: base.width * factor, height: base.height * factor }, elementHorizontalAnchor(element)),
    });
  };

  const updateElement = useCallback((elementId: string, update: Partial<PanelOverlayElement>): void => {
    setDraft((current) => ({
      ...current,
      elements: current.elements.map((element) => element.id === elementId ? { ...element, ...update } : element),
    }));
    setSaved(false);
    setError(undefined);
  }, [setError]);
  const writeStyleDocument = (next: OverlayStyleDocument): void => {
    setStyleDocument(next);
    const css = replaceOverlayStyleBlock(draft.css, next, draft.elements.map(({ id }) => id));
    setDraft((current) => ({ ...current, css }));
    setSaved(false);
    setError(undefined);
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
      notify({ tone: "success", message: labels.editorStyleCopied });
    } catch {
      notify({ tone: "error", message: labels.editorStyleCopyError });
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
    options: { min?: number; max?: number; unit?: string; ariaLabel?: string } = {},
  ): ReactElement => <NumberField id={id} label={label} value={value ?? ""}
    {...(options.min === undefined ? {} : { min: options.min })}
    {...(options.max === undefined ? {} : { max: options.max })}
    {...(options.unit === undefined ? {} : { unit: options.unit })}
    {...(options.ariaLabel === undefined ? {} : { ariaLabel: options.ariaLabel })}
    disabled={!canEdit || styleLocked} onChange={(next) => {
      if (typeof next !== "number") {
        onChange(undefined);
        return;
      }
      const minimum = options.min ?? Number.NEGATIVE_INFINITY;
      const maximum = options.max ?? Number.POSITIVE_INFINITY;
      onChange(Math.max(minimum, Math.min(maximum, next)));
    }} />;

  const discard = useCallback((): void => {
    setDraft(baseline.draft);
    setSelectedElementId(baseline.draft.elements[0]?.id ?? null);
    setSaved(false);
    setError(undefined);
    setConflictAtRevision(null);
  }, [baseline.draft, setConflictAtRevision, setError]);

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
  }, [baseline.revision, canManage, channelId, draft, labels.editorConflictDescription, labels.editorSaveError, labels.editorStyleCssLimit, labels.editorTextHint, onOverlayCreated, overlayId, persistedOverlayId, saving, setConflictAtRevision, setError, textIsValid]);

  const navigationGuard = useDraftGuard(dirty, save, discard);
  useEffect(() => registerDashboardNavigationGuard(navigationGuard.guardSwitch), [navigationGuard.guardSwitch]);

  const insertVariable = (name: string): void => {
    if (!canEdit || name.length === 0 || draft.elements.length >= OVERLAY_ELEMENT_MAXIMUM_COUNT) return;
    const element = createVariableElement(name, draft.elements);
    setDraft((current) => ({ ...current, elements: [...current.elements, element] }));
    setSelectedElementId(element.id);
    setSaved(false);
    setError(undefined);
  };

  const insertModuleElement = (option: ModuleElementOption): void => {
    if (!canEdit || draft.elements.length >= OVERLAY_ELEMENT_MAXIMUM_COUNT) return;
    const element = createModuleElement(option, draft.elements, draft.width, draft.height);
    setDraft((current) => ({ ...current, elements: [...current.elements, element] }));
    setSelectedElementId(element.id);
    setSaved(false);
    setError(undefined);
  };

  const removeElement = (elementId: string): void => {
    if (!canEdit) return;
    const remaining = draft.elements.filter(({ id }) => id !== elementId);
    const rows = orderedElements.map(({ id }) => id);
    const removedIndex = rows.indexOf(elementId);
    const neighbourId = rows[removedIndex + 1] ?? rows[removedIndex - 1];
    window.requestAnimationFrame(() => {
      const target = neighbourId === undefined
        ? document.querySelector<HTMLElement>(".overlay-editor__add-trigger")
        : document.querySelector<HTMLElement>(`[data-element-row="${CSS.escape(neighbourId)}"] .overlay-editor__element-select`);
      target?.focus();
    });
    setDraft((current) => ({ ...current, elements: remaining }));
    setSelectedElementId((currentSelectedId) => currentSelectedId === elementId
      ? remaining[0]?.id ?? null
      : currentSelectedId);
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
    const next = clampDraggedPosition(selectedElement, requestedPosition.x, requestedPosition.y);
    if (next.x !== selectedElement.x || next.y !== selectedElement.y) updateElement(selectedElement.id, next);
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

  const elementAtPoint = (point: { x: number; y: number }): PanelOverlayElement | undefined => {
    const root = previewFrameRootRef.current;
    if (root === null) return undefined;
    const rootBounds = root.getBoundingClientRect();
    const topmostFirst = draft.elements
      .map((element, index) => ({ element, index }))
      .sort((left, right) => right.element.z - left.element.z || right.index - left.index);
    for (const { element } of topmostFirst) {
      if (!element.inComposition) continue;
      const rendered = findRenderedElement(root, element.id);
      if (rendered === undefined) continue;
      const bounds = rendered.getBoundingClientRect();
      let left: number;
      let top: number;
      let width: number;
      let height: number;
      if (bounds.width === 0 && bounds.height === 0) {
        const size = moduleElementOption(element.kind)?.defaultSize ?? UNMEASURED_ELEMENT_FALLBACK_SIZE;
        const anchor = elementHorizontalAnchor(element);
        left = element.x - (anchor === "right" ? size.width : anchor === "center" ? size.width / 2 : 0);
        top = element.y;
        width = size.width;
        height = size.height;
      } else {
        left = bounds.left - rootBounds.left;
        top = bounds.top - rootBounds.top;
        width = bounds.width;
        height = bounds.height;
      }
      if (point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height) return element;
    }
    return undefined;
  };

  const startDrag = (event: PointerEvent): void => {
    const point = pointInCanvas(event);
    const element = elementAtPoint(point);
    if (element === undefined) return;
    setSelectedElementId(element.id);
    if (!canEdit || event.button !== 0) return;
    event.preventDefault();
    drag.current = { elementId: element.id, pointerId: event.pointerId, offsetX: point.x - element.x, offsetY: point.y - element.y };
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
    updateElement(active.elementId, clampDraggedPosition(
      element,
      point.x - active.offsetX,
      point.y - active.offsetY,
    ));
  };

  const stopDrag = (event: PointerEvent): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
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
    <PageHeader kind="overlays" title={overlay.name} subtitle={labels.editorReference(draft.width, draft.height)} actions={<Button variant="neutral" disabled={saving} onClick={onBack}>{labels.editorBack}</Button>} />
    <div className="overlay-editor__workspace">
      <section className="overlay-editor__elements" aria-label={labels.editorElements}>
        <div className="overlay-editor__section-heading">
          <h2>{labels.editorElements}</h2>
          <div className="overlay-editor__element-heading-actions">
            <span className="muted">{draft.elements.length} / {String(OVERLAY_ELEMENT_MAXIMUM_COUNT)}</span>
            <OverlayElementPalette
              options={paletteItems}
              messages={{
                title: labels.editorAddElement,
                searchLabel: labels.editorPaletteSearch,
                closeLabel: labels.close,
                noResults: labels.editorPaletteNoResults,
                keyHints: { navigate: labels.editorPaletteNavigate, choose: labels.editorPaletteChoose, close: labels.editorPaletteClose },
                variablesLabel: labels.editorPaletteVariables,
                categoryLabels: dashboardTexts(dashboardLocale).navigation.moduleCategories,
                ...(draft.elements.length >= OVERLAY_ELEMENT_MAXIMUM_COUNT ? { limitMessage: labels.editorElementLimit } : {}),
              }}
              trigger={<button type="button" className="overlay-editor__add-trigger" aria-label={labels.editorAddElement}
                aria-describedby={!canManage ? "overlay-editor-readonly-reason" : undefined} disabled={!canEdit}>
                <Icon name="plus" size={20} />
              </button>}
              disabled={!canEdit}
              disableEntries={draft.elements.length >= OVERLAY_ELEMENT_MAXIMUM_COUNT}
              onSelect={(option) => {
                if (option.id.startsWith("variable:")) insertVariable(option.id.slice("variable:".length));
                else if (option.id.startsWith("module:")) {
                  const moduleOption = moduleElementOption(option.id.slice("module:".length));
                  if (moduleOption !== undefined) insertModuleElement(moduleOption);
                }
              }}
            />
          </div>
        </div>
        {!canManage ? <p className="overlay-editor__locked-reason" id="overlay-editor-readonly-reason">{labels.editorLockedReason}</p> : null}
        {orderedElements.length === 0 ? <p className="muted">{labels.editorNoElements}</p> : <ul className="overlay-editor__element-list">
          {orderedElements.map((element) => <li className="overlay-editor__element-row" data-element-row={element.id} key={element.id}>
            <button className="overlay-editor__element-select" type="button" aria-pressed={element.id === selectedElementId} onClick={() => { setSelectedElementId(element.id); }}>
              <span>{element.kind === "variable"
                ? element.label || element.variableName || labels.editorVariable
                : moduleElementOption(element.kind)?.label(language) ?? (element.label || element.kind)}</span>
              {element.kind === "variable"
                ? <small>{element.variableName ?? element.missingVariableName ?? "—"}</small>
                : <small role="note">{moduleElementOption(element.kind) !== undefined && !moduleIsEnabled(moduleElementOption(element.kind)?.moduleId ?? "")
                  ? labels.editorModuleDisabled(moduleElementOption(element.kind)?.moduleName(language) ?? element.kind)
                  : labels.editorModuleElement}</small>}
            </button>
            <button type="button" className="overlay-editor__element-remove"
              aria-label={labels.editorRemoveElement(element.label || element.variableName || element.kind)}
              disabled={!canEdit} {...(canManage ? {} : { "aria-describedby": "overlay-editor-readonly-reason" })}
              onClick={() => { removeElement(element.id); }}><Icon name="remove" size={16} /></button>
          </li>)}
        </ul>}
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
        {selectedElement === null ? <p className="muted">{labels.editorNoSelection}</p> : <div className="overlay-editor__property-fields">
          {selectedElement.kind === "variable"
            ? selectedElement.variableName === null
              ? <p className="muted" role="note">{selectedElement.missingVariableName === undefined || selectedElement.missingVariableName === null
                ? labels.editorVariable
                : labels.missingVariable(selectedElement.missingVariableName)}</p>
              : <Field id="overlay-editor-variable-name" label={labels.editorVariable} value={selectedElement.variableName} readOnly onChange={() => undefined} />
            : <p className="muted" role="note">{moduleElementOption(selectedElement.kind) !== undefined && !moduleIsEnabled(moduleElementOption(selectedElement.kind)?.moduleId ?? "")
              ? labels.editorModuleDisabled(moduleElementOption(selectedElement.kind)?.moduleName(language) ?? selectedElement.kind)
              : labels.editorModuleElement}</p>}
          {selectedModuleOption === undefined ? null : (
            <ModuleOverlayElementEditor
              kind={selectedModuleOption.kind}
              config={selectedModuleOption.parseConfig(selectedElement.config) ?? selectedModuleOption.defaultConfig}
              channelId={channelId}
              language={language}
              onPreviewState={updateSelectedPreviewState}
              readOnly={!canManage}
              {...(canManage ? {} : { readOnlyReason: labels.editorReadOnly })}
              onChange={(config) => { updateElement(selectedElement.id, { config }); }}
            />
          )}
          <Field id="overlay-editor-label" label={labels.editorLabel} value={selectedElement.label} maxLength={40}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={!canEdit}
            onChange={(label) => { updateElement(selectedElement.id, { label }); }} />
          {selectedElement.kind === "variable" ? <Field id="overlay-editor-text" label={labels.editorDisplayText} hint={labels.editorTextHint} value={selectedElement.text} maxLength={100}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={!canEdit}
            onChange={(text) => { updateElement(selectedElement.id, { text }); }} /> : null}
          <div className="overlay-editor__numeric-fields">
            <NumberField id="overlay-editor-x" label={labels.editorX} value={selectedElement.x} disabled={!canEdit}
              onChange={(x) => { if (typeof x === "number") updateElement(selectedElement.id, clampDraggedPosition(selectedElement, x, selectedElement.y)); }} />
            <NumberField id="overlay-editor-y" label={labels.editorY} value={selectedElement.y} disabled={!canEdit}
              onChange={(y) => { if (typeof y === "number") updateElement(selectedElement.id, clampDraggedPosition(selectedElement, selectedElement.x, y)); }} />
            <NumberField id="overlay-editor-scale" label={labels.editorScale} min={25} max={400} value={selectedElement.scalePercent} disabled={!canEdit}
              onChange={(scalePercent) => { if (typeof scalePercent === "number") scaleElement(selectedElement, Math.max(25, Math.min(400, Math.round(scalePercent)))); }} />
            <NumberField id="overlay-editor-z" label={labels.editorZ} value={selectedElement.z} disabled={!canEdit}
              onChange={(z) => { if (typeof z === "number") updateElement(selectedElement.id, { z: Math.round(z) }); }} />
          </div>
          <div className="overlay-editor__layer-actions">
            <Button variant="neutral" disabled={!canEdit || orderedElements[0]?.id === selectedElement.id} onClick={() => { moveLayer(1); }}>{labels.editorMoveForward}</Button>
            <Button variant="neutral" disabled={!canEdit || orderedElements.at(-1)?.id === selectedElement.id} onClick={() => { moveLayer(-1); }}>{labels.editorMoveBackward}</Button>
          </div>
          <Switch layout="inline" label={labels.editorInComposition} checked={selectedElement.inComposition} disabled={!canEdit}
            onChange={(inComposition) => { updateElement(selectedElement.id, { inComposition }); }} />
        </div>}
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
              <div className="overlay-editor__style-lock" data-locked={styleLocked} {...(styleLocked ? { role: "status" } : { "aria-hidden": true })}>
                {styleLocked ? <>
                  <p {...(canManage ? { id: "overlay-style-disabled-reason" } : {})}>{labels.editorStyleLocked}</p>
                  <Button variant="neutral" disabled={!canEdit || parsedStyleBlock.contentStart === null}
                    {...(canManage ? {} : { title: labels.editorStyleReadOnlyReason, describedBy: "overlay-style-disabled-reason" })}
                    onClick={rewriteStylesFromEditor}>{labels.editorStyleRewrite}</Button>
                </> : null}
              </div>
              <StyleDisclosureSection key={`${effectiveStyleTargetId}:font`} section="font" icon="styleFont" title={labels.editorStyleFontSection}
                summary={styleSectionSummary(targetStyle, "font", labels.editorStyleSectionUnset, labels.editorStyleLeft, labels.editorStyleCenter, labels.editorStyleRight)} defaultExpanded>
                <div className="overlay-editor__style-grid">
                  {/* Own rows, not a compact pair: the custom-name hint and character
                      counter need the full panel width, or the hint wraps one syllable
                      per line in the ~280px properties column (#237). */}
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
                  {/* Short visible labels: the section heading already says "Shadow", and the
                      full names ("Shadow X offset" etc.) still reach assistive tech via
                      `ariaLabel`, which overrides the visible <label> as the accessible name (#237). */}
                  <div className="overlay-editor__style-pair overlay-editor__style-pair--triple">
                    {renderStyleNumber("overlay-editor-style-shadow-x", labels.editorStyleShadowXShort, targetStyle.shadow?.x,
                      (value) => { updateStyleProperty("shadow", value === undefined ? undefined : { ...targetStyle.shadow, x: value, y: targetStyle.shadow?.y ?? 2, blur: targetStyle.shadow?.blur ?? 4, color: targetStyle.shadow?.color ?? "#000000" }); }, { min: -100, max: 100, unit: "px", ariaLabel: labels.editorStyleShadowX })}
                    {renderStyleNumber("overlay-editor-style-shadow-y", labels.editorStyleShadowYShort, targetStyle.shadow?.y,
                      (value) => { updateStyleProperty("shadow", value === undefined ? undefined : { ...targetStyle.shadow, x: targetStyle.shadow?.x ?? 0, y: value, blur: targetStyle.shadow?.blur ?? 4, color: targetStyle.shadow?.color ?? "#000000" }); }, { min: -100, max: 100, unit: "px", ariaLabel: labels.editorStyleShadowY })}
                    {renderStyleNumber("overlay-editor-style-shadow-blur", labels.editorStyleShadowBlurShort, targetStyle.shadow?.blur,
                      (value) => { updateStyleProperty("shadow", value === undefined ? undefined : { ...targetStyle.shadow, x: targetStyle.shadow?.x ?? 0, y: targetStyle.shadow?.y ?? 2, blur: value, color: targetStyle.shadow?.color ?? "#000000" }); }, { min: 0, max: 100, unit: "px", ariaLabel: labels.editorStyleShadowBlur })}
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
