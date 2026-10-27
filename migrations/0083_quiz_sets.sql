CREATE TABLE quiz_sets (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  set_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX quiz_sets_channel_name_idx ON quiz_sets (channel_id, name, set_id);

CREATE TABLE quiz_questions (
  set_id TEXT NOT NULL REFERENCES quiz_sets(set_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 200),
  options_json TEXT NOT NULL CHECK (
    json_valid(options_json)
    AND json_type(options_json) = 'array'
    AND json_array_length(options_json) BETWEEN 2 AND 4
  ),
  correct_index INTEGER NOT NULL CHECK (correct_index >= 0 AND correct_index < json_array_length(options_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (set_id, position)
);

CREATE TRIGGER quiz_questions_validate_options_insert BEFORE INSERT ON quiz_questions
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.options_json)
   WHERE type <> 'text' OR length(trim(value)) = 0 OR length(value) > 80
)
BEGIN
  SELECT RAISE(ABORT, 'quiz_option_invalid');
END;

CREATE TRIGGER quiz_questions_validate_options_update BEFORE UPDATE OF options_json ON quiz_questions
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.options_json)
   WHERE type <> 'text' OR length(trim(value)) = 0 OR length(value) > 80
)
BEGIN
  SELECT RAISE(ABORT, 'quiz_option_invalid');
END;

INSERT INTO panel_resource_dependencies (source_table, resource)
VALUES ('quiz_sets', 'module:quiz:data'), ('quiz_questions', 'module:quiz:data');

CREATE TRIGGER panel_rev_quiz_sets_insert AFTER INSERT ON quiz_sets BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'quiz_sets'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_quiz_sets_update AFTER UPDATE ON quiz_sets
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.set_id IS NOT NEW.set_id OR OLD.name IS NOT NEW.name
  OR OLD.revision IS NOT NEW.revision OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'quiz_sets'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_quiz_sets_delete AFTER DELETE ON quiz_sets BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'quiz_sets'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_quiz_questions_insert AFTER INSERT ON quiz_questions BEGIN
  INSERT INTO panel_resource_revisions
  SELECT quiz_sets.channel_id, dependency.resource, 1
    FROM quiz_sets JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'quiz_questions'
   WHERE quiz_sets.set_id = NEW.set_id
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_quiz_questions_update AFTER UPDATE ON quiz_questions
WHEN OLD.set_id IS NOT NEW.set_id OR OLD.position IS NOT NEW.position OR OLD.text IS NOT NEW.text
  OR OLD.options_json IS NOT NEW.options_json OR OLD.correct_index IS NOT NEW.correct_index OR OLD.enabled IS NOT NEW.enabled
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT quiz_sets.channel_id, dependency.resource, 1
    FROM quiz_sets JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'quiz_questions'
   WHERE quiz_sets.set_id = NEW.set_id
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_quiz_questions_delete AFTER DELETE ON quiz_questions BEGIN
  INSERT INTO panel_resource_revisions
  SELECT quiz_sets.channel_id, dependency.resource, 1
    FROM quiz_sets JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'quiz_questions'
   WHERE quiz_sets.set_id = OLD.set_id
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
