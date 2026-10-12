ALTER TABLE channel_modules ADD COLUMN initialized INTEGER NOT NULL DEFAULT 0
  CHECK (initialized IN (0, 1));

UPDATE channel_modules
   SET initialized = 1
 WHERE enabled = 1
    OR EXISTS (
      SELECT 1
        FROM audit_log
       WHERE audit_log.channel_id = channel_modules.channel_id
         AND audit_log.module_id = channel_modules.module_id
         AND (
           audit_log.action = 'module.enabled'
           OR (
             audit_log.action = 'module.disabled'
             AND json_valid(audit_log.before_json)
             AND json_extract(audit_log.before_json, '$.enabled') = 1
           )
         )
    );
