import type { SpotifyTrack } from "./track";
import { CHAT_VOTING_LABEL_MAX_LENGTH } from "../../chat_voting/domain";

const MAX_BALLOT_OPTIONS = 9;

const normalizedLabel = (label: string): string => label.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const shortened = (label: string, maximum: number): string => Array.from(label).slice(0, maximum).join("").trim();

export const songVoteLabels = (tracks: readonly Pick<SpotifyTrack, "name">[]): string[] => {
  const used = new Set<string>();
  return tracks.slice(0, MAX_BALLOT_OPTIONS).map((track, index) => {
    const fallback = `Track ${String(index + 1)}`;
    const title = shortened(track.name.trim(), CHAT_VOTING_LABEL_MAX_LENGTH) || fallback;
    let label = normalizedLabel(title).length > 0 ? title : fallback;
    let collision = 2;
    while (used.has(normalizedLabel(label))) {
      const suffix = ` (${String(collision)})`;
      label = `${shortened(title, CHAT_VOTING_LABEL_MAX_LENGTH - Array.from(suffix).length)}${suffix}`;
      collision += 1;
    }
    used.add(normalizedLabel(label));
    return label;
  });
};
