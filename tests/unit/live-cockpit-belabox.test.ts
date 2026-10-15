import { describe, expect, it } from "vitest";

import {
  belaboxObservationIsExpired,
  failedBelaboxObservation,
  latestBelaboxObservation,
  successfulManualBelaboxObservation,
} from "../../src/dashboard/live-cockpit-belabox";

describe("live cockpit BELABOX observations", () => {
  it("lets a later polling failure replace a successful manual check", () => {
    const manualCheck = successfulManualBelaboxObservation(200, 210, true, 4_200, null);
    const laterPollFailure = failedBelaboxObservation(220, manualCheck);

    const latest = latestBelaboxObservation(manualCheck, laterPollFailure);

    expect(latest.failed).toBe(true);
    expect(latest.connected).toBe(false);
    expect(belaboxObservationIsExpired(latest, 220)).toBe(true);
  });

  it("expires manual samples using the poll interval", () => {
    const manualCheck = successfulManualBelaboxObservation(1_000, 1_000, true, 4_200, null);

    expect(belaboxObservationIsExpired(manualCheck, 10_999)).toBe(false);
    expect(belaboxObservationIsExpired(manualCheck, 11_001)).toBe(true);
  });

  it("ignores a delayed response that began before a newer failure", () => {
    const failure = failedBelaboxObservation(300, null);
    const delayedSuccess = successfulManualBelaboxObservation(100, 350, true, 4_200, failure);

    const latest = latestBelaboxObservation(failure, delayedSuccess);

    expect(latest).toBe(failure);
    expect(latest.failed).toBe(true);
  });
});
