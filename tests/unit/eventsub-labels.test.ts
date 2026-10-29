import { describe, expect, it } from "vitest";

import { EVENTSUB_NEUTRAL_REASON_CODES } from "../../src/contracts/values";
import { maintenanceReasonText } from "../../src/dashboard/locale";
import { eventSubName } from "../../src/dashboard/module-labels";
import { EVENTSUB_SUBSCRIPTION_DEFINITIONS } from "../../src/worker/eventsub-subscriptions";

const languages = ["de", "en"] as const;

// Codes the worker writes to `eventsub_subscriptions.reason`: its own maintenance codes, Twitch API error
// codes passed through, and Twitch's revocation statuses.
const knownReasonCodes = [
  ...EVENTSUB_NEUTRAL_REASON_CODES,
  "timeout", "network_error", "invalid_response", "invalid_target", "pagination_loop", "maintenance_failed",
  "moderator_status_failed", "channel_or_consent_missing", "token_ciphertext_unreadable", "refresh_failed",
  "invalid_grant", "rate_limited", "subscription_replaced", "missing_scope",
  "authorization_revoked", "user_removed", "moderator_removed", "chat_user_banned", "notification_failures_exceeded",
  "version_removed", "beta_maintenance", "webhook_callback_verification_pending", "webhook_callback_verification_failed",
  "Unauthorized", "Forbidden", "Bad Request", "Conflict", "Too Many Requests",
] as const;

describe("EventSub labels", () => {
  it.each(languages)("labels every subscription definition in %s", (language) => {
    for (const definition of EVENTSUB_SUBSCRIPTION_DEFINITIONS) {
      const label = eventSubName(definition.subscriptionType, definition.variant, language);
      expect(label, `${definition.subscriptionType}/${definition.variant}`).not.toBe(definition.subscriptionType);
      expect(label).not.toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });

  it("keeps German and English labels distinct for the named raid variants and unknown types raw", () => {
    expect(eventSubName("channel.raid", "incoming", "en")).toBe("Incoming raids");
    expect(eventSubName("channel.raid", "incoming", "de")).toBe("Eingehende Raids");
    expect(eventSubName("channel.update", "", "en")).toBe("Channel updates");
    expect(eventSubName("channel.future_event", "", "en")).toBe("channel.future_event");
  });

  it.each(languages)("localizes every known reason code in %s", (language) => {
    for (const code of knownReasonCodes) {
      expect(maintenanceReasonText(code, language), code).not.toBe(code);
    }
  });

  it("falls back to the raw code for unknown reasons and names HTTP statuses", () => {
    expect(maintenanceReasonText("some_future_reason", "en")).toBe("some_future_reason");
    expect(maintenanceReasonText("http_503", "de")).toBe("HTTP 503");
  });
});
