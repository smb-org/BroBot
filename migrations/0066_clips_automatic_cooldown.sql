UPDATE channel_modules
   SET settings = json_set(settings, '$.automaticCooldownSeconds', 60),
       revision = revision + 1
 WHERE module_id = 'clips'
   AND json_valid(settings)
   AND json_extract(settings, '$.automaticClipsEnabled') = 1
   AND json_type(settings, '$.automaticCooldownSeconds') IN ('integer', 'real')
   AND CAST(json_extract(settings, '$.automaticCooldownSeconds') AS REAL) < 60;
