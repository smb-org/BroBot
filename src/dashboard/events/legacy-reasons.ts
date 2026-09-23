/**
 * Reason values the event log renamed away from German machine ids to
 * English ones (`ads.skipped`, `raid.invalid`, `shoutout.suppressed` --
 * issue #191). Already-persisted rows keep their old value, and the event
 * log's 14-day retention means `events/model.ts`'s `eventDetail` has to
 * tolerate both for a while. Kept in its own file, not inline, because it's
 * the one place old German values legitimately have to appear as literal
 * source text (they're map keys, not prose) -- `german-guard.test.ts`
 * allowlists it for exactly that reason, the same as this project's other
 * small single-purpose exceptions.
 * ponytail: drop after 2026-10-08 (event log retention 14 days)
 */
export const LEGACY_REASON_VALUES: Readonly<Record<string, string>> = {
  dauer_null: "duration_zero",
  dauer_ungueltig: "duration_invalid",
  start_ungueltig: "start_invalid",
  ziel_ungueltig: "target_invalid",
  quelle_ungueltig: "source_invalid",
  zuschauer_ungueltig: "viewers_invalid",
  unter_schwelle: "below_threshold",
  abgeschaltet: "disabled",
};
