import { useEffect, useState, type ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { Select } from "../../../dashboard/ui";
import { textBlockOverlayEditorTexts } from "./locale";
import { previewStateFor } from "./preview-state";

interface TextBlockChoice {
  name: string;
}

interface TextBlockResponse {
  block?: {
    variants?: readonly {
      conditions?: Readonly<Record<string, unknown>>;
      texts?: readonly string[];
    }[];
  };
}

const sampleText = (text: string, examples: Readonly<Record<string, string>>): string => text.replace(/\{([a-z][a-z0-9_.]{0,63})\}/gu, (_token, name: string) =>
  examples[name] ?? (name.includes(".") ? "42" : name));

const TextBlockOverlayEditor = ({ config, onChange, channelId = "", language = "en", onPreviewState, readOnly = false }: OverlayElementEditorProps): ReactElement => {
  const [blockList, setBlockList] = useState<{ channelId: string; blocks: readonly TextBlockChoice[]; status: "ready" | "error" } | null>(null);
  const [loadedPreview, setLoadedPreview] = useState<{ blockName: string; text: string } | null>(null);
  const blockName = typeof config.blockName === "string" ? config.blockName : "";
  const labels = textBlockOverlayEditorTexts[language];
  const blocks = blockList?.channelId === channelId ? blockList.blocks : [];
  const loadState = channelId.length === 0 ? "error" : blockList?.channelId === channelId ? blockList.status : "loading";
  const previewText = loadedPreview?.blockName === blockName ? loadedPreview.text : "";

  useEffect(() => {
    if (channelId.length === 0) return;
    const controller = new AbortController();
    const url = "/api/channels/" + encodeURIComponent(channelId) + "/modules/text_library/blocks";
    void fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Block list unavailable.");
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { blocks?: unknown }).blocks)) throw new Error("Block list malformed.");
        setBlockList({
          channelId,
          blocks: (payload as { blocks: readonly TextBlockChoice[] }).blocks.filter((block) => typeof block.name === "string"),
          status: "ready",
        });
      })
      .catch(() => { if (!controller.signal.aborted) setBlockList({ channelId, blocks: [], status: "error" }); });
    return () => controller.abort();
  }, [channelId]);

  useEffect(() => {
    if (blockName.length === 0 || channelId.length === 0) {
      onPreviewState?.(null);
      return;
    }
    const controller = new AbortController();
    const url = "/api/channels/" + encodeURIComponent(channelId) + "/modules/text_library/blocks/" + encodeURIComponent(blockName);
    void fetch(url, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Block unavailable.");
      const payload: TextBlockResponse = await response.json();
      const variants = payload.block?.variants ?? [];
      const defaultVariant = [...variants].reverse().find((variant) => Object.keys(variant.conditions ?? {}).length === 0);
      const text = defaultVariant?.texts?.[0] ?? "";
      if (controller.signal.aborted) return;
      setLoadedPreview({ blockName, text });
      onPreviewState?.(text.length === 0 ? null : previewStateFor(text, labels.sampleValues));
    }).catch(() => {
      if (controller.signal.aborted) return;
      setLoadedPreview({ blockName, text: "" });
      onPreviewState?.(null);
    });
    return () => controller.abort();
  }, [blockName, channelId, labels.sampleValues, onPreviewState]);

  return <div className="text-block-overlay-editor">
    <Select
      id="overlay-editor-text-block-name"
      label={labels.label}
      value={blockName.length === 0 ? null : blockName}
      disabled={readOnly || loadState !== "ready" || blocks.length === 0}
      options={blocks.map(({ name }) => ({ value: name, label: name }))}
      onChange={(value) => { if (!readOnly && value !== null) onChange({ ...config, blockName: value }); }}
    />
    {loadState === "loading" ? <p className="form-hint" role="status">{labels.loading}</p> : null}
    {loadState === "error" ? <p className="form-error" role="status">{labels.unavailable}</p> : null}
    {loadState === "ready" && blocks.length === 0 ? <p className="form-hint">{labels.empty}</p> : null}
    {previewText.length > 0 ? <p className="form-hint" aria-live="polite">{sampleText(previewText, labels.sampleValues)}</p> : null}
  </div>;
};

export default TextBlockOverlayEditor;
