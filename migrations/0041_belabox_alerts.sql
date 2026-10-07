ALTER TABLE belabox_status
  ADD COLUMN alert_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(alert_json));

UPDATE channel_modules
   SET settings = json_set(
     settings,
     '$.alertsEnabled', json(CASE
       WHEN json_extract(settings, '$.alertsEnabled') = 0 THEN 'false'
       ELSE 'true' END),
     '$.lowBitrateKbps', COALESCE(json_extract(settings, '$.lowBitrateKbps'), 1000),
     '$.recoverBitrateKbps', COALESCE(json_extract(settings, '$.recoverBitrateKbps'), 2000),
     '$.holdSeconds', COALESCE(json_extract(settings, '$.holdSeconds'), max(10, COALESCE(json_extract(settings, '$.intervalSeconds'), 15))),
     '$.recoverHoldSeconds', COALESCE(json_extract(settings, '$.recoverHoldSeconds'), max(15, COALESCE(json_extract(settings, '$.intervalSeconds'), 15))),
     '$.chatCooldownSeconds', COALESCE(json_extract(settings, '$.chatCooldownSeconds'), 300),
     '$.chatEnabled', json(CASE
       WHEN json_extract(settings, '$.chatEnabled') = 1 THEN 'true'
       ELSE 'false' END),
     '$.lowText', COALESCE(json_extract(settings, '$.lowText'), CASE channels.language
       WHEN 'de' THEN '⚠️ Stream-Verbindung schwach: {belabox.bitrate}. Bin gleich wieder stabil.'
       ELSE '⚠️ Stream connection weak: {belabox.bitrate}. Hang tight.' END),
     '$.disconnectText', COALESCE(json_extract(settings, '$.disconnectText'), CASE channels.language
       WHEN 'de' THEN '⚠️ Verbindung zum Encoder verloren – Moment bitte.'
       ELSE '⚠️ Lost connection to the encoder – one moment.' END),
     '$.recoveryText', COALESCE(json_extract(settings, '$.recoveryText'), CASE channels.language
       WHEN 'de' THEN '✅ Verbindung wieder stabil ({belabox.bitrate}, {belabox.down_for} Ausfall).'
       ELSE '✅ Connection stable again ({belabox.bitrate}, down for {belabox.down_for}).' END),
     '$.lowTarget', COALESCE(json_extract(settings, '$.lowTarget'), 'source_only'),
     '$.disconnectTarget', COALESCE(json_extract(settings, '$.disconnectTarget'), 'source_only'),
     '$.recoveryTarget', COALESCE(json_extract(settings, '$.recoveryTarget'), 'source_only')
   )
  FROM channels
 WHERE channel_modules.channel_id = channels.channel_id
   AND channel_modules.module_id = 'belabox'
   AND json_valid(channel_modules.settings);
