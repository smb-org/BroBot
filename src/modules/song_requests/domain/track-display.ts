import type { SongRequestTrackDisplay } from "./track";

const displayArtists = (artists: readonly string[]): string => artists
  .map((artist) => artist.trim())
  .filter((artist) => artist.length > 0)
  .slice(0, 2)
  .join(", ");

export const songRequestArtistDisplay = (artists: readonly string[]): string => displayArtists(artists);

const songRequestAlbumDisplay = (title: string, albumName: string | null | undefined): string | null => {
  const album = albumName?.trim() ?? "";
  if (album.length === 0) return null;
  const normalizedTitle = title.trim().toLowerCase();
  const normalizedAlbum = album.toLowerCase();
  if (normalizedAlbum === normalizedTitle || normalizedTitle.includes(normalizedAlbum)) return null;
  return album;
};

export const formatSongRequestTrack = ({ title, artists, albumName }: SongRequestTrackDisplay): string => {
  const artist = displayArtists(artists);
  const base = artist.length === 0 ? title : `${artist} – ${title}`;
  const album = songRequestAlbumDisplay(title, albumName);
  return album === null ? base : `${base} (${album})`;
};
