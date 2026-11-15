export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  explicit: boolean;
  artists: readonly { id: string; name: string }[];
  album: { name: string; images: readonly { url: string; width: number; height: number }[] };
  external_urls: { spotify: string };
}

const TRACK_ID = /^[A-Za-z0-9]{1,64}$/u;

export const spotifyTrackIdFromInput = (input: string): string | null => {
  const value = input.trim();
  const uri = /^spotify:track:([A-Za-z0-9]{1,64})$/u.exec(value);
  if (uri !== null) return uri[1] ?? null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "open.spotify.com") return null;
    const match = /^\/track\/([A-Za-z0-9]{1,64})\/?$/u.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
};

export const isSpotifyTrack = (value: unknown): value is SpotifyTrack => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const track = value as Record<string, unknown>;
  return typeof track.id === "string" && TRACK_ID.test(track.id) &&
    typeof track.uri === "string" && track.uri === `spotify:track:${track.id}` &&
    typeof track.name === "string" && Number.isSafeInteger(track.duration_ms) &&
    typeof track.explicit === "boolean" && Array.isArray(track.artists) &&
    typeof track.album === "object" && track.album !== null &&
    typeof track.external_urls === "object" && track.external_urls !== null;
};

export const compactSpotifyTrack = (track: SpotifyTrack) => ({
  id: track.id,
  uri: track.uri,
  title: track.name.slice(0, 200),
  artists: track.artists.map(({ name }) => name.slice(0, 100)).slice(0, 8),
  durationMs: track.duration_ms,
  explicit: track.explicit,
  coverUrl: track.album.images[0]?.url ?? null,
  spotifyUrl: track.external_urls.spotify,
});
