import type { SongRequestChapterTrack } from "../contracts";

export type ChapterRandomIndex = (maximumExclusive: number) => number;

/** Uses rejection sampling so every valid index has the same chance. */
const secureChapterRandomIndex: ChapterRandomIndex = (maximumExclusive) => {
  const range = 0x1_0000_0000;
  if (!Number.isSafeInteger(maximumExclusive) || maximumExclusive < 1 || maximumExclusive > range) {
    throw new RangeError("The random range must be a positive 32-bit integer.");
  }
  const limit = Math.floor(range / maximumExclusive) * maximumExclusive;
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while ((value[0] ?? range) >= limit);
  return (value[0] ?? 0) % maximumExclusive;
};

/** Removes ineligible tracks, then draws up to three distinct candidates. */
export const drawChapterCandidates = (
  tracks: readonly SongRequestChapterTrack[],
  excludedTrackIds: ReadonlySet<string>,
  randomIndex: ChapterRandomIndex = secureChapterRandomIndex,
): SongRequestChapterTrack[] => {
  const eligible = tracks.filter((track, index) =>
    !excludedTrackIds.has(track.id) && tracks.findIndex((candidate) => candidate.id === track.id) === index,
  );
  const drawCount = Math.min(3, eligible.length);
  const pool = [...eligible];
  const drawn: SongRequestChapterTrack[] = [];
  for (let index = 0; index < drawCount; index += 1) {
    const selectedIndex = randomIndex(pool.length);
    if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= pool.length) {
      throw new RangeError("The random source returned an invalid index.");
    }
    const [selected] = pool.splice(selectedIndex, 1);
    if (selected !== undefined) drawn.push(selected);
  }
  return drawn;
};
