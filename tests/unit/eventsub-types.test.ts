import { describe, expect, it } from "vitest";

import { EVENTSUB_SUBSCRIPTION_TYPES } from "../../src/contracts/values";
import { EVENTSUB_SUBSCRIPTION_DEFINITIONS } from "../../src/worker/eventsub-subscriptions";

/**
 * Die Abotypen stehen in `contracts/`, weil die Module sie brauchen und nicht
 * aus `worker/` importieren dürfen; die Bedingungen zum Anlegen stehen im
 * Worker, weil nur er sie baut. Zwei Orte heißt: sie können auseinanderlaufen.
 * Der Compiler merkt nur die eine Richtung — ein Typ in der Tabelle, den das
 * Tupel nicht kennt, ist ein Typfehler. Die andere Richtung, ein Tupeleintrag
 * ohne Abo, bliebe stumm: der Bot würde ihn nie bei Twitch anlegen.
 */
describe("EventSub-Abotypen", () => {
  it("hält Tupel und Definitionstabelle deckungsgleich", () => {
    const fromTable = [...new Set(
      EVENTSUB_SUBSCRIPTION_DEFINITIONS.map((definition) => definition.subscriptionType),
    )].sort();
    expect(fromTable).toEqual([...EVENTSUB_SUBSCRIPTION_TYPES].sort());
  });
});
