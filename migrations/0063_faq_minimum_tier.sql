ALTER TABLE faq_entries ADD COLUMN minimum_tier TEXT NOT NULL DEFAULT 'everyone'
  CHECK (minimum_tier IN ('everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'));
