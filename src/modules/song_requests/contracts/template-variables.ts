import type { ModuleTemplateVariableGroup, TemplateFields, TemplateVariable } from "../../contract";
import type { SongRequestsSettings } from "../contracts";

const defineVariable = (
  name: string,
  labelDe: string,
  labelEn: string,
  descriptionDe: string,
  descriptionEn: string,
  sample: string,
  maxLength: number,
): TemplateVariable => ({
  name,
  maxLength,
  sample,
  contexts: ["event"],
  picker: {
    de: { label: labelDe, description: descriptionDe },
    en: { label: labelEn, description: descriptionEn },
  },
});

const track = defineVariable("song.track", "Song", "Track", "Künstler, Titel und Album, sofern es sich unterscheidet.", "Artist, title, and album when it is distinct.", "Nightwish – Sleeping Sun (Oceanborn)", 420);
const artist = defineVariable("song.artist", "Künstler", "Artist", "Die ersten zwei Künstlernamen.", "The first two artist names.", "Nightwish", 200);
const title = defineVariable("song.title", "Titel", "Title", "Der unveränderte Songtitel.", "The unchanged track title.", "Sleeping Sun", 200);
const album = defineVariable("song.album", "Album", "Album", "Der Albumname; kann leer sein.", "The album name; may be empty.", "Oceanborn", 200);
const position = defineVariable("song.position", "Position", "Position", "Position in BroBots Song-Wunschliste.", "Position in BroBot's song request list.", "1", 4);
const type = defineVariable("song.type", "Wunschtyp", "Request type", "Lokalisierte Bezeichnung der Wunschquelle.", "Localized label for the request source.", "Kostenlos", 32);

export const SONG_REQUEST_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [track, artist, title, album, position, type];

export const SONG_REQUEST_TEMPLATE_FIELDS = {
  queuedText: SONG_REQUEST_TEMPLATE_VARIABLES,
  waitingText: SONG_REQUEST_TEMPLATE_VARIABLES,
  requestAlertText: SONG_REQUEST_TEMPLATE_VARIABLES,
} as const satisfies TemplateFields<SongRequestsSettings>;

export const songRequestTemplateVariableGroup: ModuleTemplateVariableGroup = {
  label: { de: "Song-Wünsche", en: "Song requests" },
  icon: { paths: ["M9 18V5l12-2v13", "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0", "M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0"] },
  order: 46,
};
