import { useState } from "react";
import { createRoot } from "react-dom/client";

import SlotOverlay from "../../src/modules/emote_slots/overlay/slot";
import type { JsonObject } from "../../src/modules/contract";

const fixtureNow = Date.now();

const firstSpin: JsonObject = {
  spinId: "fixture-spin-one",
  login: "pixelwanderer_with_a_long_login",
  language: "de",
  outcome: "win",
  spunAt: new Date(fixtureNow).toISOString(),
  symbols: [
    { source: "emoji", code: "🍒" },
    { source: "seven_tv", code: "pixelwave", sevenTvId: "active-emote" },
    { source: "twitch", code: "moonwave", twitchId: "moon-wave" },
  ],
  net: 70,
  jackpot: 1_256,
  jackpotHit: false,
};

const secondSpin: JsonObject = {
  spinId: "fixture-spin-two",
  login: "pixelwanderer",
  language: "de",
  outcome: "pair",
  spunAt: new Date(fixtureNow + 1_000).toISOString(),
  symbols: [
    { source: "seven_tv", code: "ghostwave", sevenTvId: "removed-emote", missing: true },
    { source: "twitch", code: "moonwave", twitchId: "failed-emote" },
    { source: "seven_tv", code: "pixelwave", sevenTvId: "failed-emote" },
  ],
  net: 0,
  jackpot: 1_300,
  jackpotHit: true,
};

export const Fixture = () => {
  const [state, setState] = useState(firstSpin);
  return <main>
    <div style={{ position: "absolute", left: 32, bottom: 32 }}><SlotOverlay config={{}} state={state} now={fixtureNow} language="en" /></div>
    <button type="button" onClick={() => { setState(secondSpin); }}>Trigger next spin</button>
  </main>;
};

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
