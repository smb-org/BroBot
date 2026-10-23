ALTER TABLE twitch_login_identity
  ADD COLUMN refresh_lease_owner TEXT NULL;

ALTER TABLE twitch_login_identity
  ADD COLUMN refresh_lease_until INTEGER NULL;
