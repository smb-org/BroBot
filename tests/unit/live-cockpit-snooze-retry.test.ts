import { describe, expect, it } from "vitest";

import { PanelApiError } from "../../src/contracts/panel-error";
import { adSnoozeRetryMessage } from "../../src/dashboard/ad-snooze-retry";
import { dashboardLanguage } from "../../src/dashboard/locale";

describe("ad snooze retry message", () => {
  it("renders the retry time in the channel time zone, not the process zone", () => {
    const retryAfter = Date.now() + 3_600_000;
    const error = new PanelApiError(429, "rate_limited", { detail: { retryAfter } });

    const message = adSnoozeRetryMessage(error, "Asia/Tokyo", (time) => time);

    const expected = new Intl.DateTimeFormat(dashboardLanguage(), { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(retryAfter);
    const tokyoHour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Tokyo" }).format(retryAfter)) % 24;
    expect(message).toBe(expected);
    expect(message).toContain(String(tokyoHour).padStart(2, "0"));
  });
});
