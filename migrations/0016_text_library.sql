CREATE TABLE text_library_settings (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  time_zone TEXT NOT NULL DEFAULT 'Europe/Berlin',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  graph_revision INTEGER NOT NULL DEFAULT 1 CHECK (graph_revision >= 1),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE text_library_categories (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  category_id TEXT NOT NULL CHECK (length(category_id) BETWEEN 1 AND 40),
  catalog_key TEXT,
  custom_name TEXT CHECK (custom_name IS NULL OR length(custom_name) BETWEEN 1 AND 40),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, category_id),
  UNIQUE (channel_id, catalog_key)
);

CREATE TABLE text_blocks (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  block_name TEXT NOT NULL CHECK (block_name NOT GLOB '*[^a-z0-9_]*' AND length(block_name) BETWEEN 1 AND 32),
  category_id TEXT NOT NULL,
  games_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(games_json) AND json_type(games_json) = 'array'),
  last_chosen_index INTEGER NOT NULL DEFAULT -1 CHECK (last_chosen_index >= -1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, block_name),
  FOREIGN KEY (channel_id, category_id) REFERENCES text_library_categories(channel_id, category_id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX text_blocks_category_idx ON text_blocks(channel_id, category_id, block_name);

CREATE TABLE text_block_variants (
  channel_id TEXT NOT NULL,
  block_name TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json) AND json_type(conditions_json) = 'object'),
  texts_json TEXT NOT NULL CHECK (json_valid(texts_json) AND json_type(texts_json) = 'array'),
  PRIMARY KEY (channel_id, block_name, variant_id),
  UNIQUE (channel_id, block_name, position),
  FOREIGN KEY (channel_id, block_name) REFERENCES text_blocks(channel_id, block_name) ON DELETE CASCADE
);

ALTER TABLE text_commands ADD COLUMN games_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(games_json) AND json_type(games_json) = 'array');
