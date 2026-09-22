import { describe, expect, it } from "vitest";

import { EVENTSUB_SUBSCRIPTION_TYPES } from "../../src/contracts/values";
import { EVENTSUB_SUBSCRIPTION_DEFINITIONS } from "../../src/worker/eventsub-subscriptions";

/**
 * The subscription types live in `contracts/`, because the modules need
 * them and aren't allowed to import from `worker/`; the conditions for
 * creating them live in the worker, because only it builds them. Two
 * locations means they can drift apart. The compiler only catches one
 * direction — a type in the table that the tuple doesn't know is a type
 * error. The other direction, a tuple entry without a subscription, would
 * stay silent: the bot would never create it on Twitch.
 */
describe("EventSub subscription types", () => {
  it("keeps the tuple and the definition table congruent", () => {
    const fromTable = [...new Set(
      EVENTSUB_SUBSCRIPTION_DEFINITIONS.map((definition) => definition.subscriptionType),
    )].sort();
    expect(fromTable).toEqual([...EVENTSUB_SUBSCRIPTION_TYPES].sort());
  });
});
