UPDATE channel_modules
   SET settings = json_set(
     settings,
     '$.startText', CASE WHEN json_extract(settings, '$.startText') IS NULL OR json_extract(settings, '$.startText') = 'Votekick for {votekick.target} is open for {votekick.window}. 1 = yes, 2 = no. Needed: {votekick.threshold} net yes votes.'
       THEN 'Votekick gegen {votekick.target} läuft für {votekick.window}. 1 = Ja, 2 = Nein. Benötigt: {votekick.threshold} Netto-Ja-Stimmen.' ELSE json_extract(settings, '$.startText') END,
     '$.passText', CASE WHEN json_extract(settings, '$.passText') IS NULL OR json_extract(settings, '$.passText') = 'Votekick passed: {votekick.target} receives a {votekick.duration} timeout.'
       THEN 'Votekick erfolgreich: {votekick.target} erhält einen Timeout von {votekick.duration}.' ELSE json_extract(settings, '$.passText') END,
     '$.failText', CASE WHEN json_extract(settings, '$.failText') IS NULL OR json_extract(settings, '$.failText') = 'The timeout for {votekick.target} could not be applied.'
       THEN 'Der Timeout für {votekick.target} konnte nicht angewendet werden.' ELSE json_extract(settings, '$.failText') END,
     '$.expiredText', CASE WHEN json_extract(settings, '$.expiredText') IS NULL OR json_extract(settings, '$.expiredText') = 'Votekick for {votekick.target} expired ({votekick.yes} yes, {votekick.no} no).'
       THEN 'Votekick gegen {votekick.target} abgelaufen ({votekick.yes} Ja, {votekick.no} Nein).' ELSE json_extract(settings, '$.expiredText') END,
     '$.protectedText', CASE WHEN json_extract(settings, '$.protectedText') IS NULL OR json_extract(settings, '$.protectedText') = 'A votekick cannot be started for {votekick.target}.'
       THEN 'Für {votekick.target} kann kein Votekick gestartet werden.' ELSE json_extract(settings, '$.protectedText') END,
     '$.busyText', CASE WHEN json_extract(settings, '$.busyText') IS NULL OR json_extract(settings, '$.busyText') = 'Another ballot is already running.'
       THEN 'Es läuft bereits eine Abstimmung.' ELSE json_extract(settings, '$.busyText') END
   ),
       revision = revision + 1,
       settings_revision = settings_revision + 1
  FROM channels
 WHERE channel_modules.channel_id = channels.channel_id
   AND channel_modules.module_id = 'votekick'
   AND channels.language = 'de'
   AND json_valid(channel_modules.settings)
   AND (
     json_extract(channel_modules.settings, '$.startText') IS NULL OR json_extract(channel_modules.settings, '$.startText') = 'Votekick for {votekick.target} is open for {votekick.window}. 1 = yes, 2 = no. Needed: {votekick.threshold} net yes votes.' OR
     json_extract(channel_modules.settings, '$.passText') IS NULL OR json_extract(channel_modules.settings, '$.passText') = 'Votekick passed: {votekick.target} receives a {votekick.duration} timeout.' OR
     json_extract(channel_modules.settings, '$.failText') IS NULL OR json_extract(channel_modules.settings, '$.failText') = 'The timeout for {votekick.target} could not be applied.' OR
     json_extract(channel_modules.settings, '$.expiredText') IS NULL OR json_extract(channel_modules.settings, '$.expiredText') = 'Votekick for {votekick.target} expired ({votekick.yes} yes, {votekick.no} no).' OR
     json_extract(channel_modules.settings, '$.protectedText') IS NULL OR json_extract(channel_modules.settings, '$.protectedText') = 'A votekick cannot be started for {votekick.target}.' OR
     json_extract(channel_modules.settings, '$.busyText') IS NULL OR json_extract(channel_modules.settings, '$.busyText') = 'Another ballot is already running.'
   );
