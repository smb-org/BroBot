import { createElement, lazy, Suspense, type ReactElement } from "react";

import { MODULE_OVERLAY_ELEMENTS } from "../modules/overlay-element-registry";
import type { JsonObject } from "../modules/contract";

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

export const ModuleOverlayElementEditor = ({ kind, config, channelId, language, onChange, onPreviewState, readOnly = false, readOnlyReason }: ModuleOverlayElementEditorProperties): ReactElement | null => {
  const editor = moduleElementEditors.get(kind);
  if (editor === undefined) return null;

  return <Suspense fallback={null}>{createElement(editor, {
    config,
    language,
    channelId,
    onChange,
    ...(onPreviewState === undefined ? {} : { onPreviewState }),
    readOnly,
    ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
  })}</Suspense>;
};
