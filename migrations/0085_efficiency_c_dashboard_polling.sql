-- The cockpit asks for the latest five ad announcements. Keep this partial
-- index limited to those rows so ordinary event writes do not pay its cost.
CREATE INDEX event_log_recent_ads_idx
  ON event_log(channel_id, created_at DESC, event_id DESC)
  WHERE module_id = 'ads' AND code = 'ads.announcement';
