ALTER TABLE chat_votes
  ADD COLUMN requested_duration_seconds INTEGER CHECK (
    requested_duration_seconds IS NULL OR (
      typeof(requested_duration_seconds) = 'integer' AND
      requested_duration_seconds BETWEEN 1 AND 14_400
    )
  );

UPDATE chat_votes
   SET requested_duration_seconds = CAST(ROUND((julianday(closes_at) - julianday(opened_at)) * 86400) AS INTEGER)
 WHERE close_reason = 'timer';
