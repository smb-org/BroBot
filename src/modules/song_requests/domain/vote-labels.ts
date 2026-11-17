import { formatSongRequestTrack } from "./track-display";

const MAX_BALLOT_OPTIONS = 9;
// Mirrors the chat vote label limit; chat_voting still validates every label when the vote starts.
const CHAT_VOTING_LABEL_MAX_LENGTH = 32;

const normalizedLabel = (label: string): string => label.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const shortened = (label: string, maximum: number): string => Array.from(label).slice(0, maximum).join("").trim();
const fitTitle = (title: string, maximum: number): string => Array.from(title).length > maximum
  ? `${shortened(title, Math.max(0, maximum - 1))}…`
  : title;

export const songVoteLabels = (tracks: readonly { name: string; artists: readonly { name: string }[] }[]): string[] => {
  const used = new Set<string>();
  return tracks.slice(0, MAX_BALLOT_OPTIONS).map((track, index) => {
    const fallback = `Track ${String(index + 1)}`;
    const firstArtist = track.artists[0]?.name.trim() ?? "";
    const artist = Array.from(firstArtist).length <= 14 ? firstArtist : `${shortened(firstArtist, 13)}…`;
    const rawTitle = track.name.trim() || fallback;
    const separatorIndex = rawTitle.indexOf(" - ");
    const prefix = artist.length === 0 ? "" : `${artist} – `;
    const prefixLength = Array.from(prefix).length;
    const formatTitle = (value: string): string => {
      const formattedTrack = formatSongRequestTrack({ title: value, artists: artist.length === 0 ? [] : [artist] });
      return prefix.length === 0 ? formattedTrack : formattedTrack.slice(prefix.length);
    };
    let formattedTitle = formatTitle(rawTitle);
    if (prefixLength + Array.from(formattedTitle).length > CHAT_VOTING_LABEL_MAX_LENGTH && separatorIndex > 0) {
      formattedTitle = formatTitle(rawTitle.slice(0, separatorIndex).trimEnd());
    }
    const title = fitTitle(formattedTitle, CHAT_VOTING_LABEL_MAX_LENGTH - prefixLength);
    let label = `${prefix}${title}`;
    if (normalizedLabel(label).length === 0) label = fallback;
    let collision = 2;
    while (used.has(normalizedLabel(label))) {
      const suffix = ` (${String(collision)})`;
      const titleForCollision = fitTitle(title, CHAT_VOTING_LABEL_MAX_LENGTH - prefixLength - Array.from(suffix).length);
      label = `${prefix}${titleForCollision}${suffix}`;
      collision += 1;
    }
    used.add(normalizedLabel(label));
    return label;
  });
};
