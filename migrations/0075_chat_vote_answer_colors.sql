ALTER TABLE chat_vote_templates
  ADD COLUMN answer_colors TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(answer_colors) AND json_type(answer_colors) = 'array' AND json_array_length(answer_colors) <= 9
  );

ALTER TABLE chat_vote_templates
  ADD COLUMN offer_in_cockpit INTEGER NOT NULL DEFAULT 1 CHECK (offer_in_cockpit IN (0, 1));

UPDATE chat_vote_templates
   SET answer_colors = (
     SELECT json_group_array(CASE CAST(answer.key AS INTEGER)
       WHEN 0 THEN '#5b8cff'
       WHEN 1 THEN '#ff9f43'
       WHEN 2 THEN '#2ed3a3'
       WHEN 3 THEN '#ff6fae'
       WHEN 4 THEN '#ffd45c'
       WHEN 5 THEN '#a47bff'
       WHEN 6 THEN '#68aeff'
       WHEN 7 THEN '#ff665c'
       ELSE '#c3ccdd'
     END ORDER BY CAST(answer.key AS INTEGER))
       FROM json_each(chat_vote_templates.labels) AS answer
   );

ALTER TABLE chat_votes
  ADD COLUMN answer_colors_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(answer_colors_json) AND json_type(answer_colors_json) = 'array' AND json_array_length(answer_colors_json) <= 9
  );

UPDATE chat_votes
   SET answer_colors_json = (
     SELECT json_group_array(CASE CAST(answer.key AS INTEGER)
       WHEN 0 THEN '#5b8cff'
       WHEN 1 THEN '#ff9f43'
       WHEN 2 THEN '#2ed3a3'
       WHEN 3 THEN '#ff6fae'
       WHEN 4 THEN '#ffd45c'
       WHEN 5 THEN '#a47bff'
       WHEN 6 THEN '#68aeff'
       WHEN 7 THEN '#ff665c'
       ELSE '#c3ccdd'
     END ORDER BY CAST(answer.key AS INTEGER))
       FROM json_each(chat_votes.labels_json) AS answer
   );
