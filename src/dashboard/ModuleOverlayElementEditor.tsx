import { createElement, lazy, Suspense, type ReactElement } from "react";

import { MODULE_OVERLAY_ELEMENTS } from "../modules/overlay-element-registry";
import type { JsonObject } from "../modules/contract";
import { Skeleton } from "./ui";

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
  MODULE_OVERLAY_ELEMENTS.flatMap(({ definition }) => definition.editor === undefined
    ? []
    : [[definition.kind, lazy(definition.editor)] as const]),
);

const moduleEditorReservedHeights: Readonly<Record<string, string>> = {
  "ads.countdown": "calc(var(--s10) * 2)",
  "chat_voting.tally": "calc(var(--s10) * 8)",
  "text_library.block": "calc(var(--s10) * 6)",
  "belabox.status": "calc(var(--s10) * 4)",
  "votekick.tally": "calc(var(--s10) * 3)",
};

export const ModuleOverlayElementEditor = ({ kind, config, channelId, language, onChange, onPreviewState, readOnly = false, readOnlyReason }: ModuleOverlayElementEditorProperties): ReactElement | null => {
  const editor = moduleElementEditors.get(kind);
  if (editor === undefined) return null;
  const reservedHeight = moduleEditorReservedHeights[kind] ?? "calc(var(--s10) * 8)";

  return <Suspense fallback={<div className="module-overlay-element-editor" data-kind={kind} aria-hidden="true" style={{ minHeight: reservedHeight }}><Skeleton rows={3} height={34} /></div>}>
    <div className="module-overlay-element-editor" data-kind={kind} style={{ minHeight: reservedHeight }}>
      {createElement(editor, {
        config,
        language,
        channelId,
        onChange,
        ...(onPreviewState === undefined ? {} : { onPreviewState }),
        readOnly,
        ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
      })}
    </div>
  </Suspense>;
};
