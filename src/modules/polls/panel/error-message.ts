import { PanelApiError } from "../../../contracts/panel-error";
import type { pollsPanelTexts } from "./locale";

type PollsErrorLabels = typeof pollsPanelTexts.en;

export const pollsApiErrorMessage = (error: unknown, labels: PollsErrorLabels): string => {
  if (!(error instanceof PanelApiError)) return labels.requestFailed;
  const code = error.code;
  if (code === "polls_not_eligible") return labels.notEligible;
  if (code === "polls_already_active") return labels.alreadyActive;
  if (code === "polls_not_connected") return labels.missingConnection;
  if (code === "polls_token_unavailable") return labels.tokenUnavailable;
  if (code === "polls_scope_missing") return labels.missingScope;
  if (code === "polls_revoked") return labels.revoked;
  if (code === "polls_refresh_failed") return labels.refreshFailed;
  if (code === "polls_rate_limited" || error.status === 429) return labels.rateLimited;
  if (code === "polls_network") return labels.network;
  if (code === "polls_unknown_status") return labels.twitchStatusUnknown;
  if (code === "polls_invalid_response") return labels.twitchInvalidResponse;
  if (code === "polls_entry_limit") return labels.entryLimit;
  if (code === "polls_entry_conflict") return labels.conflict;
  if (code === "polls_module_disabled") return labels.moduleDisabled;
  if (code === "polls_management_denied" || code === "polls_precondition_failed") return labels.managementDenied;
  if (code === "polls_run_not_found" || code === "polls_entry_not_found") return labels.runNotFound;
  if (code === "polls_not_open") return labels.notOpen;
  if (code === "polls_run_not_dismissible") return labels.notDismissible;
  if (code === "polls_invalid_choice") return labels.choiceInvalid;
  if (code === "polls_invalid_entry" || code === "polls_invalid_input") return labels.invalidEntry;
  return labels.requestFailed;
};
