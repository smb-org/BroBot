import { useCallback, type ComponentType, type ReactElement } from "react";

import { MODULE_OVERLAY_ELEMENTS } from "../modules/overlay-element-registry";
import type { JsonObject, OverlayElementEditorProps } from "../modules/contract";
import { loadModuleOverlayElementEditor, retryModuleChunkLoad } from "./module-panel-loaders";
import { RetryableLazy } from "./RetryableLazy";
import { Button, LoadStateLines } from "./ui";
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

const moduleElements = new Map(MODULE_OVERLAY_ELEMENTS.map((registered) => [registered.definition.kind, registered] as const));

const moduleEditorReservedHeights: Readonly<Record<string, string>> = {
  // Each value is the measured height of the loaded editor, rounded up to the token grid.
  "ads.countdown": "calc(var(--s10) + var(--s1))",
  "chat_voting.tally": "calc(var(--s10) * 8)",
  "text_library.block": "calc(var(--s10) * 7)",
  "belabox.status": "calc(var(--s10) * 6 + var(--s4))",
  "votekick.tally": "calc(var(--s10) * 3 + var(--s3))",
  "statistics.word_counter": "calc(var(--s10) * 6 + var(--s6) + var(--s3))",
  "statistics.word_ranking": "calc(var(--s10) * 12)",
  "song_requests.now_playing": "calc(var(--s10) * 8)",
  "quiz.session": "calc(var(--s10) * 4 + var(--s3))",
  "overlay_alerts.alert": "calc(var(--s10) * 2)",
  "emote_slots.slot": "calc(var(--s10) + var(--s6) + var(--s1))",
};

export const ModuleOverlayElementEditor = ({ kind, config, channelId, language, onChange, onPreviewState, readOnly = false, readOnlyReason }: ModuleOverlayElementEditorProperties): ReactElement | null => {
  const registered = moduleElements.get(kind);
  const loadEditor = useCallback(() => loadModuleOverlayElementEditor(kind) as Promise<{ default: ComponentType<OverlayElementEditorProps> }>, [kind]);
  if (registered === undefined) return null;
  const reservedHeight = moduleEditorReservedHeights[kind] ?? "calc(var(--s10) * 8)";

  return <div className="module-overlay-element-editor" data-kind={kind}>
    {registered.definition.editor === undefined ? null : <div className="module-overlay-element-editor__element" style={{ minHeight: reservedHeight }}><RetryableLazy
        instanceKey={`${registered.moduleId}:overlay-editor:${kind}`}
        load={loadEditor}
        onRetry={retryModuleChunkLoad}
        properties={{
          config,
          language,
          channelId,
          onChange,
          ...(onPreviewState === undefined ? {} : { onPreviewState }),
          readOnly,
          ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
        }}
        loadingFallback={<div data-module-editor-fallback="true" aria-hidden="true"><LoadStateLines rows={1} height={34} /></div>}
        renderError={(retry) => <div className="module-overlay-element-editor--error" role="alert">
          <p>{dashboardTexts().module.componentLoadError}</p>
          <Button size="compact" variant="neutral" onClick={retry}>{dashboardCommonTexts(language).retry}</Button>
        </div>}
      /></div>}
  </div>;
};
