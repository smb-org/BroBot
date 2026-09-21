-- scopes_json bedeutet: jemals erteilte Zustimmung; die Liste wird bei Logins
-- vereinigt und wächst. token_scopes_json bedeutet: Umfang des gespeicherten
-- Tokens; diese Aussage wird ersetzt und kann schrumpfen.
-- Es gibt keinen Backfill: '[]' ist der ehrliche Startwert, weil die
-- Vereinigung breiter sein kann als das gespeicherte Token. Beim nächsten
-- Login und beim nächsten Wartungslauf füllt sich die Spalte selbst.
ALTER TABLE twitch_login_identity
  ADD COLUMN token_scopes_json TEXT NOT NULL DEFAULT '[]';
