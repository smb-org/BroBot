-- Mindeststufe je Textbefehl; die Migration macht bestehende Befehle nicht enger.
ALTER TABLE textbefehle_commands ADD COLUMN minimum_level TEXT NOT NULL DEFAULT 'alle'
  CHECK (minimum_level IN ('alle', 'abonnent', 'vip', 'moderator', 'broadcaster'));
