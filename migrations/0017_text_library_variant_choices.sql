ALTER TABLE text_block_variants ADD COLUMN last_chosen_index INTEGER NOT NULL DEFAULT -1
  CHECK (last_chosen_index >= -1);
