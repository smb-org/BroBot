import {
  OVERLAY_ELEMENT_MAXIMUM_COUNT,
} from "../../contracts/values";
import {
  getOverlayForChannel,
  hasChannelVariableForOverlay,
  isOverlayManagementAllowed,
  updateOverlayDraftWithAudit,
  type OverlayDraft,
  type OverlayDraftElement,
  type OverlayRecord,
} from "../db/overlays";
import type { ActorContext } from "../db/guards";

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)] as const);
  return Object.fromEntries(entries);
};

const sameElement = (left: OverlayDraftElement, right: OverlayDraftElement): boolean =>
  left.id === right.id && left.label === right.label &&
  left.variableName === right.variableName && left.text === right.text &&
  JSON.stringify(stableValue(left.config)) === JSON.stringify(stableValue(right.config)) &&
  left.x === right.x && left.y === right.y && left.scalePercent === right.scalePercent &&
  left.z === right.z && left.inComposition === right.inComposition;

const sameOverlay = (before: OverlayRecord, draft: OverlayDraft): boolean =>
  before.name === draft.name && before.width === draft.width && before.height === draft.height && before.css === draft.css;

export type SaveOverlayDraftResult =
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "conflict"; current: OverlayRecord | null }
  | { outcome: "element_limit" }
  | { outcome: "invalid_reference" }
  | { outcome: "unchanged"; overlay: OverlayRecord; rowsWritten: 0 }
  | { outcome: "saved"; overlay: OverlayRecord; rowsWritten: number };

export const saveOverlayDraft = async (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  overlayId: string,
  baseRevision: number,
  draft: OverlayDraft,
  changedAt: string,
): Promise<SaveOverlayDraftResult> => {
  const before = await getOverlayForChannel(db, channelId, overlayId);
  if (before === null) return { outcome: "not_found" };
  if (draft.elements.length > OVERLAY_ELEMENT_MAXIMUM_COUNT) return { outcome: "element_limit" };
  if (baseRevision !== before.revision) return { outcome: "conflict", current: before };
  const variableNames = [...new Set(draft.elements.flatMap((element) =>
    element.variableName === null ? [] : [element.variableName]))];
  for (const variableName of variableNames) {
    if (!await hasChannelVariableForOverlay(db, channelId, variableName)) return { outcome: "invalid_reference" };
  }

  const beforeById = new Map(before.elements.map((element) => [element.id, element]));
  const draftById = new Map(draft.elements.map((element) => [element.id, element]));
  const added = draft.elements.filter((element) => !beforeById.has(element.id));
  const changed = draft.elements.filter((element) => {
    const previous = beforeById.get(element.id);
    return previous !== undefined && !sameElement(previous, element);
  });
  const removed = before.elements.filter((element) => !draftById.has(element.id));
  const elementsChanged = added.length + changed.length + removed.length > 0;
  if (sameOverlay(before, draft) && !elementsChanged) {
    return { outcome: "unchanged", overlay: before, rowsWritten: 0 };
  }

  const mutation = await updateOverlayDraftWithAudit(db, actor, before, draft, changedAt, { added, changed, removed });
  if (mutation.changes === 0) {
    const current = await getOverlayForChannel(db, channelId, overlayId);
    if (current === null) return { outcome: "not_found" };
    if (!await isOverlayManagementAllowed(db, actor, channelId, changedAt)) return { outcome: "forbidden" };
    return { outcome: "conflict", current };
  }
  const overlay = await getOverlayForChannel(db, channelId, overlayId);
  if (overlay === null) return { outcome: "not_found" };
  return { outcome: "saved", overlay, rowsWritten: mutation.rowsWritten };
};
