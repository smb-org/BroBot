import type { ReactElement } from "react";
import type { ModuleLanguage } from "../../contract";
import { bossFightCatalog } from "../locale";
import "./live-tile.css";

export interface BossFightLiveTileRound {
  id: string;
  currentHp: number;
  maxHp: number;
  attackers: number;
  closesAt: string;
}

export const BossFightLiveTile = ({ language, round, now }: {
  language: ModuleLanguage;
  round: BossFightLiveTileRound;
  now: number;
}): ReactElement => {
  const copy = bossFightCatalog[language];
  const remaining = Math.max(0, Math.ceil((Date.parse(round.closesAt) - now) / 1_000));
  const time = `${String(Math.floor(remaining / 60))}:${String(remaining % 60).padStart(2, "0")}`;
  return <article className="live-cockpit-boss-fight" data-testid="live-boss-fight-tile">
    <span className="live-cockpit-boss-fight__name">{copy.title}</span>
    <strong className="live-cockpit-boss-fight__health">{`${String(round.currentHp)} / ${String(round.maxHp)} HP`}</strong>
    <span className="live-cockpit-boss-fight__meta">{`${String(round.attackers)} ${copy.attacker(round.attackers)} · ${copy.timeLeft(time)}`}</span>
  </article>;
};
