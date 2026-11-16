export const songRequestsActionTexts = {
  de: {
    name: "Song-Abstimmung starten", queueName: "Song-Warteschlange", search: "Spotify-Suche", query: "Song, Spotify-Link oder URI", searchButton: "Suchen",
    add: "Hinzufügen", addTrack: (title: string) => `${title} hinzufügen`, added: "Hinzugefügt",
    candidate: "Kandidat", removeTrack: (title: string) => `${title} aus den Kandidaten entfernen`,
    selected: "Kandidaten", emptyCandidates: "Noch keine Kandidaten", emptyResults: "Keine Songs gefunden.",
    loading: "Verbindung und Stream werden geprüft …", unavailable: "Spotify verbinden und den Stream starten, um eine Abstimmung zu öffnen.",
    failed: "Spotify-Suche fehlgeschlagen.", run: "Abstimmung starten", started: "Song-Abstimmung gestartet.",
    error: "Song-Abstimmung konnte nicht gestartet werden.", busy: "Es läuft bereits eine Abstimmung.",
  },
  en: {
    name: "Start song vote", queueName: "Song request queue", search: "Spotify search", query: "Track, Spotify link, or URI", searchButton: "Search",
    add: "Add", addTrack: (title: string) => `Add ${title}`, added: "Added",
    candidate: "Candidate", removeTrack: (title: string) => `Remove ${title} from candidates`,
    selected: "Candidates", emptyCandidates: "No candidates yet", emptyResults: "No tracks found.",
    loading: "Checking Spotify and stream …", unavailable: "Connect Spotify and start the stream to open a vote.",
    failed: "Spotify search failed.", run: "Start vote", started: "Song vote started.",
    error: "Could not start the song vote.", busy: "Another vote is already open.",
  },
} as const;
