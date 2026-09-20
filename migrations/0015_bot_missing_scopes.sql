-- Der stündliche Wartungslauf hält den aus den gespeicherten Bot-Scopes
-- abgeleiteten Soll/Ist-Zustand fest, damit das Panel keine Prüfung übernimmt.
ALTER TABLE bot_identity
  ADD COLUMN missing_scopes_json TEXT;
