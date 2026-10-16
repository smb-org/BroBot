UPDATE channel_modules
   SET settings = json_set(settings, '$.autoCloseSeconds', 120)
 WHERE module_id = 'chat_voting'
   AND json_valid(settings)
   AND COALESCE(CAST(json_extract(settings, '$.autoCloseSeconds') AS INTEGER), 0) = 0;
