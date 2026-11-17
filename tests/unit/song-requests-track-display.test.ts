import { describe, expect, it } from "vitest";

import { renderTemplate } from "../../src/template";
import { SONG_REQUEST_TEMPLATE_FIELDS, SONG_REQUEST_TEMPLATE_VARIABLES } from "../../src/modules/song_requests/contracts/template-variables";
import { songRequestsSettingsForLanguage } from "../../src/modules/song_requests/contracts";
import { formatSongRequestTrack } from "../../src/modules/song_requests/domain/track-display";

describe("song request track display", () => {
  it("formats the first two artists, title, and distinct album without changing the title", () => {
    expect(formatSongRequestTrack({
      title: "Sleeping Sun - From 'Oceanborn'",
      artists: ["Nightwish", "Mira Vale", "Rowan March"],
      albumName: "Oceanborn",
    })).toBe("Nightwish, Mira Vale – Sleeping Sun - From 'Oceanborn'");
  });

  it.each([
    { albumName: null, title: "Sleeping Sun" },
    { albumName: "", title: "Sleeping Sun" },
    { albumName: "Sleeping Sun", title: "Sleeping Sun" },
    { albumName: "OCEANBORN", title: "Sleeping Sun - oceanborn edition" },
  ])("omits an empty, duplicate, or already-contained album", ({ albumName, title }) => {
    expect(formatSongRequestTrack({ title, artists: ["Nightwish"], albumName })).toBe(`Nightwish – ${title}`);
  });

  it("renders templates with a formatted track and with or without the album variable", () => {
    const track = formatSongRequestTrack({ title: "Sleeping Sun", artists: ["Nightwish"], albumName: "Oceanborn" });
    const queued = songRequestsSettingsForLanguage("de").queuedText;
    expect(renderTemplate(queued, { "song.track": track, "song.position": 2 }, {}, SONG_REQUEST_TEMPLATE_VARIABLES))
      .toBe("„Nightwish – Sleeping Sun (Oceanborn)“ wurde in Spotify eingereiht. Position 2.");
    expect(renderTemplate("{song.artist} – {song.title} ({song.album})", {
      "song.artist": "Nightwish", "song.title": "Sleeping Sun", "song.album": "Oceanborn",
    }, {}, SONG_REQUEST_TEMPLATE_VARIABLES)).toBe("Nightwish – Sleeping Sun (Oceanborn)");
    expect(renderTemplate("{song.artist} – {song.title}", {
      "song.artist": "Nightwish", "song.title": "Sleeping Sun", "song.album": "",
    }, {}, SONG_REQUEST_TEMPLATE_VARIABLES)).toBe("Nightwish – Sleeping Sun");
    expect(Object.keys(SONG_REQUEST_TEMPLATE_FIELDS)).toEqual(["queuedText", "waitingText", "requestAlertText"]);
  });

  it("uses localized request-result and moderator-wait defaults", () => {
    expect(songRequestsSettingsForLanguage("en").queuedText).toBe("“{song.track}” was queued in Spotify. Position {song.position}.");
    expect(songRequestsSettingsForLanguage("de").queuedText).toBe("„{song.track}“ wurde in Spotify eingereiht. Position {song.position}.");
    expect(songRequestsSettingsForLanguage("en").waitingText).toBe("“{song.track}” is waiting for moderator approval.");
    expect(songRequestsSettingsForLanguage("de").waitingText).toBe("„{song.track}“ wartet auf die Freigabe durch die Moderation.");
    expect(songRequestsSettingsForLanguage("en").requestAlertText).toBe("{user} · {song.type}: {song.track}");
    expect(songRequestsSettingsForLanguage("de").requestAlertText).toBe("{user} · {song.type}: {song.track}");
  });
});
