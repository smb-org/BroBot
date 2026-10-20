CREATE TABLE blitz_questions (
  channel_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scramble', 'quiz')),
  prompt TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, question_id)
);

CREATE INDEX blitz_questions_pick ON blitz_questions (channel_id, enabled, last_used_at);

INSERT INTO panel_resource_dependencies (source_table, resource)
VALUES ('blitz_questions', 'module:blitz_round:data');

CREATE TRIGGER panel_rev_blitz_questions_insert AFTER INSERT ON blitz_questions BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'blitz_questions' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_blitz_questions_update AFTER UPDATE ON blitz_questions BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'blitz_questions' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_blitz_questions_delete AFTER DELETE ON blitz_questions BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'blitz_questions' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
