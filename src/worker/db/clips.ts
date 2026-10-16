import type { SessionClipList } from "../../modules/clips/contracts";
import { ANY_MEMBER_ROLES, actorGuard, bindActorGuard, type ActorContext } from "./guards";

interface SessionClipRow {
  stream_started_at: string | null;
  clip_id: string | null;
  created_at: string | null;
}

export const clipsModuleIsActiveForActor = async (
  db: D1Database,
  channelId: string,
  actor: ActorContext,
  now: string,
): Promise<boolean> => {
  const row = await db.prepare(
    `SELECT 1 AS active
       FROM channel_modules AS module
      WHERE module.channel_id = ?
        AND module.module_id = 'clips'
        AND module.enabled = 1
        ${actorGuard(ANY_MEMBER_ROLES)}`,
  ).bind(channelId, ...bindActorGuard(actor, channelId, now)).first<{ active: number }>();
  return row !== null;
};

export const listCurrentSessionClips = async (
  db: D1Database,
  channelId: string,
  actor: ActorContext,
  now: string,
): Promise<SessionClipList | null> => {
  const result = await db.prepare(
    `WITH clip_session AS (
      SELECT module.channel_id,
             stream_state.started_at AS stream_started_at
        FROM channel_modules AS module
        LEFT JOIN channel_stream_state AS stream_state
          ON stream_state.channel_id = module.channel_id
         AND stream_state.state = 'online'
       WHERE module.channel_id = ?
         AND module.module_id = 'clips'
         AND module.enabled = 1
        ${actorGuard(ANY_MEMBER_ROLES)}
    )
    SELECT clip_session.stream_started_at,
           json_extract(audit.after_json, '$.clipId') AS clip_id,
           audit.created_at
      FROM clip_session
      LEFT JOIN audit_log AS audit
        ON audit.channel_id = clip_session.channel_id
       AND audit.action = 'clip.created'
       AND clip_session.stream_started_at IS NOT NULL
       AND audit.created_at >= clip_session.stream_started_at
     ORDER BY audit.created_at DESC
     LIMIT 100`,
  ).bind(channelId, ...bindActorGuard(actor, channelId, now)).all<SessionClipRow>();
  const first = result.results[0];
  if (first === undefined) return null;
  return {
    streamStartedAt: first.stream_started_at,
    clips: result.results.flatMap((row) => row.clip_id === null || row.created_at === null
      ? []
      : [{ clipId: row.clip_id, createdAt: row.created_at }]),
  };
};
