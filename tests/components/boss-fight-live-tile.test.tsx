import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BossFightLiveTile } from "../../src/modules/boss_fight/panel/live-tile";

afterEach(() => { cleanup(); });

describe("boss fight live tile", () => {
  it("shows current health, distinct attackers, and the fixed round deadline", () => {
    render(<BossFightLiveTile
      language="en"
      round={{ id: "boss-round", currentHp: 350, maxHp: 380, attackers: 1, closesAt: "2030-01-01T00:01:30.000Z" }}
      now={Date.parse("2030-01-01T00:00:30.000Z")}
    />);

    const tile = screen.getByTestId("live-boss-fight-tile");
    expect(tile.textContent).toContain("350 / 380 HP");
    expect(tile.textContent).toContain("1 attacker");
    expect(tile.textContent).toContain("1:00");
  });
});
