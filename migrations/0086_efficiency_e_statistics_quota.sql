CREATE INDEX channel_statistics_stream_window_idx
  ON channel_statistics(channel_id, stream_id, window_start);

CREATE INDEX api_source_quota_window_start_idx
  ON api_source_quota(window_start);
