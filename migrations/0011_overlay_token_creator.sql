ALTER TABLE overlay_tokens ADD COLUMN created_by_user_id TEXT;

UPDATE overlay_tokens
   SET created_by_user_id = (
     SELECT issued.actor_user_id
       FROM audit_log AS issued
      WHERE issued.channel_id = overlay_tokens.channel_id
        AND issued.action = 'overlay.token.issued'
        AND json_extract(issued.after_json, '$.tokenId') = overlay_tokens.token_id
      ORDER BY issued.created_at, issued.audit_id
      LIMIT 1
   )
 WHERE EXISTS (
     SELECT 1
       FROM audit_log AS issued
      WHERE issued.channel_id = overlay_tokens.channel_id
        AND issued.action = 'overlay.token.issued'
        AND json_extract(issued.after_json, '$.tokenId') = overlay_tokens.token_id
   );
