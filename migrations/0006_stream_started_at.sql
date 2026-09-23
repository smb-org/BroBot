-- The actual stream start time, kept apart from `changed_at` (the
-- conflict-resolution timestamp used to decide which write wins). Nullable:
-- existing rows and offline states carry no start time.
ALTER TABLE channel_stream_state ADD COLUMN started_at TEXT;
