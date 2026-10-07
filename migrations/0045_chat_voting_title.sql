ALTER TABLE chat_votes
  ADD COLUMN title TEXT CHECK (
    title IS NULL OR (length(title) BETWEEN 1 AND 80 AND trim(title) = title)
  );
