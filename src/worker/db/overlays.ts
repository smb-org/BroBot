import { actorGuard, bindActorGuard, type ActorContext } from "./guards";
import { prepareAudit } from "./audit";
import {
  MANAGING_ROLES,
  OVERLAY_MAXIMUM_COUNT,
  type OverlayElementKind,
} from "../../contracts/values";

export type OverlayJsonObject = Readonly<Record<string, unknown>>;

export interface OverlayDraftElement {
  id: string;
  kind: OverlayElementKind;
  label: string;
  variableName: string | null;
  text: string;
  config: OverlayJsonObject;
  x: number;
  y: number;
  scalePercent: number;
  z: number;
  inComposition: boolean;
}

export interface OverlayDraft {
  name: string;
  width: number;
  height: number;
  css: string;
  elements: readonly OverlayDraftElement[];
}

export interface OverlayRecord extends OverlayDraft {
  id: string;
  channelId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface OverlaySummary {
  id: string;
  name: string;
  width: number;
  height: number;
  revision: number;
  elementCount: number;
  createdAt: string;
  updatedAt: string;
}

interface OverlayRow {
  overlay_id: string;
  channel_id: string;
  name: string;
  width: number;
  height: number;
  css: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface OverlayElementRow {
  element_id: string;
  channel_id: string;
  overlay_id: string;
  kind: string;
  label: string;
  variable_name: string | null;
  text: string;
  config_json: string;
  x: number;
  y: number;
  scale_percent: number;
  z: number;
  in_composition: number;
}

interface OverlaySummaryRow extends OverlayRow {
  element_count: number;
}

const mapElement = (row: OverlayElementRow): OverlayDraftElement => ({
  id: row.element_id,
  kind: row.kind as OverlayElementKind,
  label: row.label,
  variableName: row.variable_name,
  text: row.text,
  config: JSON.parse(row.config_json) as OverlayJsonObject,
  x: row.x,
  y: row.y,
  scalePercent: row.scale_percent,
  z: row.z,
  inComposition: row.in_composition === 1,
});

export const listOverlaysForChannel = async (
  db: D1Database,
  channelId: string,
): Promise<OverlaySummary[]> => {
  const result = await db.prepare(
    `SELECT overlay.overlay_id, overlay.channel_id, overlay.name, overlay.width, overlay.height,
            overlay.css, overlay.revision, overlay.created_at, overlay.updated_at,
            (SELECT COUNT(*) FROM overlay_elements AS element
              WHERE element.channel_id = overlay.channel_id AND element.overlay_id = overlay.overlay_id) AS element_count
       FROM overlays AS overlay
      WHERE overlay.channel_id = ?
      ORDER BY overlay.created_at, overlay.overlay_id`,
  ).bind(channelId).all<OverlaySummaryRow>();
  return result.results.map((row) => ({
    id: row.overlay_id,
    name: row.name,
    width: row.width,
    height: row.height,
    revision: row.revision,
    elementCount: row.element_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
};

export const getOverlayForChannel = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
): Promise<OverlayRecord | null> => {
  const row = await db.prepare(
    `SELECT overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at
       FROM overlays
      WHERE channel_id = ? AND overlay_id = ?`,
  )
    .bind(channelId, overlayId).first<OverlayRow>();
  if (row === null) return null;
  const elements = await db.prepare(
    `SELECT element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json,
            x, y, scale_percent, z, in_composition
       FROM overlay_elements
      WHERE channel_id = ? AND overlay_id = ?
      ORDER BY z, element_id`,
  ).bind(channelId, overlayId).all<OverlayElementRow>();
  return {
    id: row.overlay_id,
    channelId: row.channel_id,
    name: row.name,
    width: row.width,
    height: row.height,
    css: row.css,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    elements: elements.results.map(mapElement),
  };
};

export const countOverlaysForChannel = async (db: D1Database, channelId: string): Promise<number> => {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM overlays WHERE channel_id = ?")
    .bind(channelId).first<{ count: number }>();
  return row?.count ?? 0;
};

export const hasChannelVariableForOverlay = async (
  db: D1Database,
  channelId: string,
  variableName: string,
): Promise<boolean> => {
  const row = await db.prepare(
    "SELECT 1 AS present FROM channel_variables WHERE channel_id = ? AND name = ?",
  ).bind(channelId, variableName).first<{ present: number }>();
  return row !== null;
};

export const overlayUsesVariable = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
  variableName: string,
): Promise<boolean> => {
  const row = await db.prepare(
    `SELECT 1 AS present
       FROM overlay_elements
      WHERE channel_id = ? AND overlay_id = ? AND variable_name = ?
      LIMIT 1`,
  ).bind(channelId, overlayId, variableName).first<{ present: number }>();
  return row !== null;
};

export const getOverlayVariableValues = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
): Promise<Record<string, number>> => {
  const rows = await db.prepare(
    `SELECT variable.name, variable.value
       FROM channel_variables AS variable
      WHERE variable.channel_id = ?
        AND variable.name IN (
          SELECT DISTINCT element.variable_name
            FROM overlay_elements AS element
           WHERE element.channel_id = ? AND element.overlay_id = ?
             AND element.variable_name IS NOT NULL
        )
      ORDER BY variable.name`,
  ).bind(channelId, channelId, overlayId).all<{ name: string; value: number }>();
  return Object.fromEntries(rows.results.map(({ name, value }) => [name, value]));
};

const auditSnapshot = (overlay: Pick<OverlayRecord, "id" | "name" | "width" | "height" | "revision" | "elements">) => ({
  overlayId: overlay.id,
  name: overlay.name,
  width: overlay.width,
  height: overlay.height,
  revision: overlay.revision,
  elementCount: overlay.elements.length,
});

const auditElement = (element: OverlayDraftElement) => ({ id: element.id, label: element.label });

const rowsWritten = (results: readonly D1Result[]): number =>
  results.reduce((total, result) => total + result.meta.rows_written, 0);

export const overlayElementIdCollisionGuard = (elementCount: number): string => elementCount === 0
  ? ""
  : `AND NOT EXISTS (
         SELECT 1
           FROM overlay_elements AS conflicting_element
          WHERE conflicting_element.element_id IN (${Array.from({ length: elementCount }, () => "?").join(", ")})
            AND NOT (conflicting_element.channel_id = ? AND conflicting_element.overlay_id = ?)
       )`;

export const createOverlayWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  input: { id: string; channelId: string; name: string; width: number; height: number },
  changedAt: string,
): Promise<{ changes: number; rowsWritten: number }> => {
  const mutation = db.prepare(
    `INSERT INTO overlays (overlay_id, channel_id, name, width, height, revision, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 1, ?, ?
      WHERE (SELECT COUNT(*) FROM overlays WHERE channel_id = ?) < ?
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(input.id, input.channelId, input.name, input.width, input.height, changedAt, changedAt,
    input.channelId, OVERLAY_MAXIMUM_COUNT, ...bindActorGuard(actor, input.channelId, changedAt));
  const audit = prepareAudit(db, actor.userId, changedAt, input.channelId, null, "overlay.created", null, {
    overlayId: input.id,
    name: input.name,
    width: input.width,
    height: input.height,
    revision: 1,
    elementCount: 0,
  });
  const results = await db.batch([mutation, audit]);
  return { changes: results[0]?.meta.changes ?? 0, rowsWritten: rowsWritten(results) };
};

export const isOverlayManagementAllowed = async (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  now: string,
): Promise<boolean> => {
  const row = await db.prepare(`SELECT 1 AS allowed FROM channels WHERE channel_id = ? ${actorGuard(MANAGING_ROLES)}`)
    .bind(channelId, ...bindActorGuard(actor, channelId, now)).first<{ allowed: number }>();
  return row !== null;
};

/**
 * A manager can delete a channel variable between the pre-check in the
 * service and this batch. Folding the check into the CAS guard -- instead
 * of only checking before the batch -- means a variable removed in that
 * window fails the UPDATE the same way a stale revision does, so the
 * dependent element INSERT (which would otherwise violate its foreign key
 * and roll back the whole batch) is skipped via `changes() > 0` like the
 * other guard failures.
 */
export const referencedVariablesGuard = `
        AND NOT EXISTS (
          SELECT 1
            FROM json_each(?) AS referenced_variable
           WHERE NOT EXISTS (
             SELECT 1 FROM channel_variables
              WHERE channel_id = ? AND name = referenced_variable.value
           )
        )`;

export const updateOverlayDraftWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  before: OverlayRecord,
  draft: OverlayDraft,
  changedAt: string,
  diff: {
    added: readonly OverlayDraftElement[];
    changed: readonly OverlayDraftElement[];
    removed: readonly OverlayDraftElement[];
  },
): Promise<{ changes: number; rowsWritten: number }> => {
  const addedIdGuard = overlayElementIdCollisionGuard(diff.added.length);
  const referencedVariableNames = [...new Set(draft.elements.flatMap((element) =>
    element.variableName === null ? [] : [element.variableName]))];
  const mutation = db.prepare(
    `UPDATE overlays
        SET name = ?, width = ?, height = ?, css = ?, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND overlay_id = ? AND revision = ?
        ${referencedVariablesGuard}
        ${addedIdGuard}
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(draft.name, draft.width, draft.height, draft.css, changedAt, before.channelId, before.id, before.revision,
    JSON.stringify(referencedVariableNames), before.channelId,
    ...diff.added.map((element) => element.id),
    ...(diff.added.length === 0 ? [] : [before.channelId, before.id]),
    ...bindActorGuard(actor, before.channelId, changedAt));

  const elementWrites: D1PreparedStatement[] = [
    ...diff.removed.map((element) => db.prepare(
      `DELETE FROM overlay_elements
        WHERE channel_id = ? AND overlay_id = ? AND element_id = ? AND changes() > 0`,
    ).bind(before.channelId, before.id, element.id)),
    ...diff.changed.map((element) => db.prepare(
      `UPDATE overlay_elements
          SET kind = ?, label = ?, variable_name = ?, text = ?, config_json = ?, x = ?, y = ?,
              scale_percent = ?, z = ?, in_composition = ?
        WHERE channel_id = ? AND overlay_id = ? AND element_id = ? AND changes() > 0`,
    ).bind(element.kind, element.label, element.variableName, element.text, JSON.stringify(element.config), element.x,
      element.y, element.scalePercent, element.z, element.inComposition ? 1 : 0,
      before.channelId, before.id, element.id)),
    ...diff.added.map((element) => db.prepare(
      `INSERT INTO overlay_elements
        (element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json, x, y,
         scale_percent, z, in_composition)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
    ).bind(element.id, before.channelId, before.id, element.kind, element.label, element.variableName, element.text,
      JSON.stringify(element.config), element.x, element.y, element.scalePercent, element.z, element.inComposition ? 1 : 0)),
  ];

  const after: OverlayRecord = {
    ...draft,
    id: before.id,
    channelId: before.channelId,
    revision: before.revision + 1,
    createdAt: before.createdAt,
    updatedAt: changedAt,
  };
  const beforeById = new Map(before.elements.map((element) => [element.id, element]));
  const elementChanges = {
    added: diff.added.map(auditElement),
    changed: diff.changed.map((element) => ({
      id: element.id,
      beforeLabel: beforeById.get(element.id)?.label ?? "",
      afterLabel: element.label,
    })),
    removed: diff.removed.map(auditElement),
  };
  const audit = prepareAudit(db, actor.userId, changedAt, before.channelId, null, "overlay.updated",
    auditSnapshot(before), { ...auditSnapshot(after), elementChanges });
  const results = await db.batch([mutation, ...elementWrites, audit]);
  return { changes: results[0]?.meta.changes ?? 0, rowsWritten: rowsWritten(results) };
};

export const deleteOverlayWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  before: OverlayRecord,
  baseRevision: number,
  changedAt: string,
): Promise<{ changes: number; rowsWritten: number }> => {
  const mutation = db.prepare(
    `DELETE FROM overlays
      WHERE channel_id = ? AND overlay_id = ? AND revision = ? ${actorGuard(MANAGING_ROLES)}`,
  ).bind(before.channelId, before.id, baseRevision, ...bindActorGuard(actor, before.channelId, changedAt));
  const audit = prepareAudit(db, actor.userId, changedAt, before.channelId, null, "overlay.deleted",
    auditSnapshot(before), null);
  const results = await db.batch([mutation, audit]);
  return { changes: results[0]?.meta.changes ?? 0, rowsWritten: rowsWritten(results) };
};
