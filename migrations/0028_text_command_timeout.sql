ALTER TABLE text_commands ADD COLUMN timeout_min_seconds INTEGER;
ALTER TABLE text_commands ADD COLUMN timeout_max_seconds INTEGER;
ALTER TABLE text_commands ADD COLUMN timeout_fallback_text TEXT;
