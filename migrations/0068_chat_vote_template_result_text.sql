ALTER TABLE chat_vote_templates
  ADD COLUMN result_text TEXT NOT NULL DEFAULT '{vote.result}';

UPDATE chat_vote_templates
   SET result_text = CASE
     WHEN json_valid(channel_modules.settings)
       AND json_type(channel_modules.settings, '$.resultText') = 'text'
       THEN json_extract(channel_modules.settings, '$.resultText')
     ELSE '{vote.result}'
   END
  FROM channel_modules
 WHERE channel_modules.channel_id = chat_vote_templates.channel_id
   AND channel_modules.module_id = 'chat_voting'
   AND json_valid(channel_modules.settings);
