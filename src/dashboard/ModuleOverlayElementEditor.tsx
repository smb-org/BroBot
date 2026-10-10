import { useCallback, type ComponentType, type ReactElement } from "react";

import { MODULE_OVERLAY_ELEMENTS } from "../modules/overlay-element-registry";
import type { JsonObject, OverlayElementEditorProps } from "../modules/contract";
import { loadModuleOverlayElementEditor } from "./module-panel-loaders";
import { RetryableLazy } from "./RetryableLazy";
import { Button, Skeleton } from "./ui";
import { dashboardCommonTexts, dashboardTexts } from "./locale";

type EditorJsonValue = string | number | boolean | null | readonly EditorJsonValue[] | { readonly [key: string]: EditorJsonValue };
type EditorJsonObject = Readonly<Record<string, EditorJsonValue>>;

interface ModuleOverlayElementEditorProperties {
  kind: `${string}.${string}`;
  config: EditorJsonObject;
  channelId: string;
  language: "de" | "en";
  onChange: (config: EditorJsonObject) => void;
  onPreviewState?: (state: JsonObject | null) => void;
  readOnly?: boolean;
  readOnlyReason?: string;
}

const moduleElementEditors = new Map(
  MODULE_OVERLAY_ELEMENTS.flatMap((registered) => registered.definition.editor === undefined
    ? []
    : [[registered.definition.kind, registered] as const]),
);

const moduleEditorReservedHeights: Readonly<Record<string, string>> = {
  "ads.countdown": "calc(var(--s10) * 8)",
  "chat_voting.tally": "calc(var(--s10) * 8)",
  "text_library.block": "calc(var(--s10) * 8)",
  "belabox.status": "calc(var(--s10) * 6)",
  "votekick.tally": "calc(var(--s10) * 6)",
};

export const ModuleOverlayElementEditor = ({ kind, config, channelId, language, onChange, onPreviewState, readOnly = false, readOnlyReason }: ModuleOverlayElementEditorProperties): ReactElement | null => {
  const registered = moduleElementEditors.get(kind);
  const loadEditor = useCallback(() => loadModuleOverlayElementEditor(kind) as Promise<{ default: ComponentType<OverlayElementEditorProps> }>, [kind]);
  if (registered === undefined) return null;
  const reservedHeight = moduleEditorReservedHeights[kind] ?? "calc(var(--s10) * 8)";

  return <div className="module-overlay-element-editor" data-kind={kind} style={{ minHeight: reservedHeight }}>
    <RetryableLazy
      instanceKey={`${registered.moduleId}:overlay-editor:${kind}`}
      load={loadEditor}
      properties={{
        config,
        language,
        channelId,
        onChange,
        ...(onPreviewState === undefined ? {} : { onPreviewState }),
        readOnly,
        ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
      }}
      loadingFallback={<div data-module-editor-fallback="true" aria-hidden="true"><Skeleton rows={1} height={34} /></div>}
      renderError={(retry) => <div className="module-overlay-element-editor--error" role="alert">
        <p>{dashboardTexts().module.componentLoadError}</p>
        <Button size="compact" variant="neutral" onClick={retry}>{dashboardCommonTexts(language).retry}</Button>
      </div>}
    />
  </div>;
};
