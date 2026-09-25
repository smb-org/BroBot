import { Hono } from "hono";
import { z } from "zod";

import {
  OVERLAY_ELEMENT_KINDS,
  OVERLAY_ELEMENT_MAXIMUM_COUNT,
  OVERLAY_MAXIMUM_COUNT,
  canManage,
  type ApiErrorCode,
} from "../../contracts/values";
import { isOverlayCssSafe } from "../../contracts/overlay-css";
import {
  countOverlaysForChannel,
  createOverlayWithAudit,
  deleteOverlayWithAudit,
  getOverlayForChannel,
  hasChannelVariableForOverlay,
  isOverlayManagementAllowed,
  listOverlaysForChannel,
  type OverlayDraftElement,
} from "../db/overlays";
import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "../auth/guards";
import { actorOf } from "./member-routes";
import { saveOverlayDraft } from "../overlays/service";
import { closeRealtimeTokenBeforeResponse } from "../realtime-revocation";
import { publishOverlayChanged } from "../realtime";

interface OverlayRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const VARIABLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const OVERLAY_ELEMENT_CONFIG_MAXIMUM_BYTES = 4_096;
const nowIso = (): string => new Date().toISOString();

const nameSchema = z.string().trim().min(1).max(40);

const elementConfigSchemas = {
  variable: z.record(z.string(), z.json()),
} as const;

const elementSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  kind: z.enum(OVERLAY_ELEMENT_KINDS),
  label: z.string().max(40).default(""),
  variableName: z.string().regex(VARIABLE_PATTERN).nullable().default(null),
  text: z.string().max(100).refine((value) => value.match(/\{value\}/gu)?.length === 1).default("{value}"),
  config: z.record(z.string(), z.json()).default({}),
  x: z.number().int().default(0),
  y: z.number().int().default(0),
  scalePercent: z.number().int().min(25).max(400).default(100),
  z: z.number().int().default(0),
  inComposition: z.boolean().default(true),
}).strict();

const createOverlaySchema = z.object({
  name: nameSchema,
  width: z.number().int().min(64).max(3840).default(1920),
  height: z.number().int().min(64).max(2160).default(1080),
  initialElement: elementSchema.optional(),
}).strict().superRefine((input, context) => {
  const element = input.initialElement;
  if (element === undefined) return;
  if (element.variableName === null) {
    context.addIssue({ code: "custom", path: ["initialElement", "variableName"], message: "initial element must reference a variable" });
  }
  if (element.x < 0 || element.x > input.width) {
    context.addIssue({ code: "custom", path: ["initialElement", "x"], message: "x is outside the overlay" });
  }
  if (element.y < 0 || element.y > input.height) {
    context.addIssue({ code: "custom", path: ["initialElement", "y"], message: "y is outside the overlay" });
  }
  if (!elementConfigSchemas[element.kind].safeParse(element.config).success ||
      new TextEncoder().encode(JSON.stringify(element.config)).byteLength > OVERLAY_ELEMENT_CONFIG_MAXIMUM_BYTES) {
    context.addIssue({ code: "custom", path: ["initialElement", "config"], message: "config is invalid" });
  }
});

const updateOverlaySchema = z.object({
  baseRevision: z.number().int().min(1),
  name: nameSchema,
  width: z.number().int().min(64).max(3840),
  height: z.number().int().min(64).max(2160),
  css: z.string().max(16_000),
  elements: z.array(elementSchema).max(OVERLAY_ELEMENT_MAXIMUM_COUNT),
  reconnectExpectation: z.object({
    elementId: z.string().regex(ID_PATTERN),
    missingVariableName: z.string().regex(VARIABLE_PATTERN),
  }).strict().optional(),
}).strict().superRefine((draft, context) => {
  const identifiers = new Set<string>();
  draft.elements.forEach((element, index) => {
    if (identifiers.has(element.id)) {
      context.addIssue({ code: "custom", path: ["elements", index, "id"], message: "duplicate element id" });
    }
    identifiers.add(element.id);
    if (element.x < 0 || element.x > draft.width) {
      context.addIssue({ code: "custom", path: ["elements", index, "x"], message: "x is outside the overlay" });
    }
    if (element.y < 0 || element.y > draft.height) {
      context.addIssue({ code: "custom", path: ["elements", index, "y"], message: "y is outside the overlay" });
    }
    if (!elementConfigSchemas[element.kind].safeParse(element.config).success) {
      context.addIssue({ code: "custom", path: ["elements", index, "config"], message: "config is invalid for this element kind" });
    }
    const serializedConfig = JSON.stringify(element.config);
    if (new TextEncoder().encode(serializedConfig).byteLength > OVERLAY_ELEMENT_CONFIG_MAXIMUM_BYTES) {
      context.addIssue({ code: "custom", path: ["elements", index, "config"], message: "config is too large" });
    }
  });
});

const deleteOverlaySchema = z.object({ baseRevision: z.number().int().min(1) }).strict();

const managementDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "overlay_management_denied" }, 403);

export const overlayRouter = new Hono<OverlayRouteEnvironment>();
overlayRouter.use("/api/channels/:channelId/overlays", requireChannelAuthorization());
overlayRouter.use("/api/channels/:channelId/overlays/*", requireChannelAuthorization());

overlayRouter.get("/api/channels/:channelId/overlays", async (context) => {
  const channelId = context.req.param("channelId");
  return context.json({
    overlays: await listOverlaysForChannel(context.env.DB, channelId),
    maximum: OVERLAY_MAXIMUM_COUNT,
    elementMaximum: OVERLAY_ELEMENT_MAXIMUM_COUNT,
  });
});

overlayRouter.post("/api/channels/:channelId/overlays", async (context) => {
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  const parsed = createOverlaySchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "overlay_data_invalid" }, 400);

  const channelId = context.req.param("channelId");
  const initialElement = parsed.data.initialElement as OverlayDraftElement | undefined;
  if (initialElement !== undefined && initialElement.variableName !== null &&
      !await hasChannelVariableForOverlay(context.env.DB, channelId, initialElement.variableName)) {
    return context.json({ error: "overlay_data_invalid" satisfies ApiErrorCode }, 400);
  }
  const now = nowIso();
  const id = crypto.randomUUID();
  const created = await createOverlayWithAudit(context.env.DB, actorOf(context), {
    id,
    channelId,
    name: parsed.data.name,
    width: parsed.data.width,
    height: parsed.data.height,
    ...(initialElement === undefined ? {} : { initialElement }),
  }, now);
  if (created.changes > 0) {
    const overlay = await getOverlayForChannel(context.env.DB, channelId, id);
    if (overlay === null) throw new Error("Created overlay could not be read back.");
    await publishOverlayChanged(context.env.CHANNEL, channelId, [{ overlayId: id, revision: overlay.revision }]);
    return context.json({ overlay }, 201);
  }
  if (!await isOverlayManagementAllowed(context.env.DB, actorOf(context), channelId, now)) {
    return managementDenied(context);
  }
  if (await countOverlaysForChannel(context.env.DB, channelId) >= OVERLAY_MAXIMUM_COUNT) {
    return context.json({ error: "overlay_limit_reached" }, 409);
  }
  return context.json({ error: "overlay_changed_concurrently" }, 409);
});

overlayRouter.get("/api/channels/:channelId/overlays/:overlayId", async (context) => {
  const overlay = await getOverlayForChannel(context.env.DB,
    context.req.param("channelId"), context.req.param("overlayId"));
  return overlay === null
    ? context.json({ error: "overlay_not_found" }, 404)
    : context.json({ overlay });
});

overlayRouter.put("/api/channels/:channelId/overlays/:overlayId", async (context) => {
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  const body: unknown = await context.req.json().catch(() => null);
  const submittedElements: unknown = body !== null && typeof body === "object" && !Array.isArray(body)
    ? Reflect.get(body, "elements")
    : null;
  const submittedCss: unknown = body !== null && typeof body === "object" && !Array.isArray(body)
    ? Reflect.get(body, "css")
    : null;
  if (typeof submittedCss === "string" && !isOverlayCssSafe(submittedCss)) {
    return context.json({ error: "overlay_css_invalid" satisfies ApiErrorCode }, 400);
  }
  if (Array.isArray(submittedElements) && submittedElements.length > OVERLAY_ELEMENT_MAXIMUM_COUNT) {
    return context.json({ error: "overlay_element_limit_reached" }, 409);
  }
  const parsed = updateOverlaySchema.safeParse(body);
  if (!parsed.success) {
    return context.json({ error: "overlay_data_invalid" }, 400);
  }

  const channelId = context.req.param("channelId");
  const overlayId = context.req.param("overlayId");
  const { baseRevision, reconnectExpectation, ...draft } = parsed.data;
  const result = await saveOverlayDraft(context.env.DB, actorOf(context), channelId, overlayId,
    baseRevision, draft, nowIso(), reconnectExpectation);
  if (result.outcome === "not_found") return context.json({ error: "overlay_not_found" }, 404);
  if (result.outcome === "forbidden") return managementDenied(context);
  if (result.outcome === "element_limit") return context.json({ error: "overlay_element_limit_reached" }, 409);
  if (result.outcome === "invalid_reference") return context.json({ error: "overlay_data_invalid" }, 400);
  if (result.outcome === "element_id_conflict") return context.json({ error: "overlay_element_id_conflict" }, 409);
  if (result.outcome === "reconnect_conflict") return context.json({
    error: "overlay_changed_concurrently",
    currentRevision: result.current.revision,
  }, 409);
  if (result.outcome === "conflict") {
    return context.json({
      error: "overlay_changed_concurrently",
      currentRevision: result.current?.revision ?? null,
    }, 409);
  }
  if (result.outcome === "saved") {
    await publishOverlayChanged(context.env.CHANNEL, channelId, [{ overlayId, revision: result.overlay.revision }]);
  }
  return context.json({ overlay: result.overlay });
});

overlayRouter.delete("/api/channels/:channelId/overlays/:overlayId", async (context) => {
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  const parsed = deleteOverlaySchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "overlay_data_invalid" }, 400);
  const channelId = context.req.param("channelId");
  const overlayId = context.req.param("overlayId");
  const before = await getOverlayForChannel(context.env.DB, channelId, overlayId);
  if (before === null) return context.json({ error: "overlay_not_found" }, 404);
  if (parsed.data.baseRevision !== before.revision) {
    return context.json({ error: "overlay_changed_concurrently", currentRevision: before.revision }, 409);
  }
  const now = nowIso();
  const deleted = await deleteOverlayWithAudit(context.env.DB, actorOf(context), before, parsed.data.baseRevision, now);
  if (deleted.changes > 0) {
    await publishOverlayChanged(context.env.CHANNEL, channelId, [{ overlayId, revision: before.revision }]);
    const closures = await Promise.all(deleted.revokedAccessTokenIds.map((tokenId) =>
      closeRealtimeTokenBeforeResponse(context.env.CHANNEL, channelId, tokenId)));
    if (closures.some((closed) => !closed)) return context.json({ closingPending: true }, 202);
    return new Response(null, { status: 204 });
  }
  if (!await isOverlayManagementAllowed(context.env.DB, actorOf(context), channelId, now)) {
    return managementDenied(context);
  }
  const current = await getOverlayForChannel(context.env.DB, channelId, overlayId);
  return current === null
    ? context.json({ error: "overlay_not_found" }, 404)
    : context.json({ error: "overlay_changed_concurrently", currentRevision: current.revision }, 409);
});
