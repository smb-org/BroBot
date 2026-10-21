export interface ChannelSettingsTexts {
  section: string;
  pageTitle: string;
  pageDescription: string;
  timeZone: string;
  timeZoneHint: string;
  timeZoneSection: string;
  locationMissing: string;
  locationMissingWarning: string;
  readOnly: string;
  loadError: string;
  saveError: string;
  settingsConflict: string;
  invalid: string;
  location: string;
  locationHint: string;
  locationSearch: string;
  locationSearchButton: string;
  locationSearching: string;
  locationSelect: string;
  locationResults: string;
  locationNoResults: string;
  locationAttribution: string;
  locationChange: string;
  locationRemove: string;
  locationRemoveTitle: string;
  locationRemoveDescription: string;
  cancel: string;
  locationSaveFailed: string;
  locationSearchFailed: string;
  locationTimeZoneAction: string;
  locationTimeZoneTitle: string;
  defaultChatTarget: string;
  defaultChatTargetHint: string;
}

export interface LocationLiveTexts {
  weather: string;
  currentIn: (place: string) => string;
  feelsLike: string;
  wind: string;
  updated: (minutes: number, time: string) => string;
  now: string;
  duration: (hours: number, minutes: number) => string;
  inDuration: (duration: string) => string;
  providerError: string;
  temporaryError: string;
  setLocation: string;
  missingWeatherLocation: string;
  missingSunLocation: string;
  missingMoonLocation: string;
  sun: string;
  nextPhase: string;
  nextPhaseIn: (phase: string, duration: string) => string;
  polarDay: string;
  polarNight: string;
  dawn: string;
  sunrise: string;
  solarNoon: string;
  goldenHour: string;
  sunset: string;
  blueHour: string;
  dusk: string;
  dayLength: string;
  moon: string;
  illumination: (percent: number) => string;
  moonrise: string;
  moonset: string;
  nextRise: string;
  commands: string;
  commandDescription: string;
  createCommand: string;
  existingCommand: string;
  templates: readonly { name: string; response: string }[];
  variables: string;
  weatherModule: string;
  sunModule: string;
  moonModule: string;
}

const texts: Readonly<Record<"de" | "en", ChannelSettingsTexts>> = {
  de: {
    section: "Kanaleinstellungen",
    pageTitle: "Ort & Wetter",
    pageDescription: "Standort für Wetter, Sonnenzeiten und Mondphase",
    timeZone: "Kanalzeitzone",
    timeZoneHint: "Gültige IANA-Zeitzone. Sie wird für Datum, Uhrzeit und zeitabhängige Textbausteine verwendet.",
    timeZoneSection: "Zeitzone",
    locationMissing: "Standort fehlt",
    locationMissingWarning: "Wetter, Sonnenzeiten und Mondphase benötigen einen Kanalstandort.",
    readOnly: "Nur Broadcaster und Verwalter dürfen diese Einstellung ändern.",
    loadError: "Die Kanaleinstellungen konnten nicht geladen werden.",
    saveError: "Die Zeitzone konnte nicht gespeichert werden.",
    settingsConflict: "Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.",
    invalid: "Bitte eine gültige IANA-Zeitzone eingeben.",
    location: "Standort",
    locationHint: "Gilt für Wetter, Sonnenzeiten und Mondphase. Änderungen mit Speichern übernehmen.",
    locationSearch: "Ort suchen",
    locationSearchButton: "Suchen",
    locationSearching: "Orte werden gesucht …",
    locationSelect: "Auswählen",
    locationResults: "Standortsuche",
    locationNoResults: "Keine passenden Orte gefunden.",
    locationAttribution: "Ortssuche von Open-Meteo.com",
    locationChange: "Standort ändern",
    locationRemove: "Standort entfernen",
    locationRemoveTitle: "Standort entfernen?",
    locationRemoveDescription: "Der Standort wird nach dem Speichern aus den Kanaleinstellungen entfernt.",
    cancel: "Abbrechen",
    locationSaveFailed: "Der Standort konnte nicht gespeichert werden.",
    locationSearchFailed: "Orte konnten nicht gesucht werden.",
    locationTimeZoneAction: "Zeitzone übernehmen",
    locationTimeZoneTitle: "Setzt die Kanalzeitzone auf die Zeitzone des Standorts.",
    defaultChatTarget: "Standard-Chat-Ziel",
    defaultChatTargetHint: "Wird für Einträge verwendet, die kein eigenes Chat-Ziel festlegen.",
  },
  en: {
    section: "Channel settings",
    pageTitle: "Location & weather",
    pageDescription: "Location for weather, sunrise, sunset, and moon phase",
    timeZone: "Channel time zone",
    timeZoneHint: "A valid IANA time zone used for date, time, and time based text block conditions.",
    timeZoneSection: "Time zone",
    locationMissing: "Location missing",
    locationMissingWarning: "Weather, sunrise and moon phase need a channel location.",
    readOnly: "Only broadcasters and managers can change this setting.",
    loadError: "Channel settings could not be loaded.",
    saveError: "The time zone could not be saved.",
    settingsConflict: "Settings changed in another session. Reload before saving.",
    invalid: "Enter a valid IANA time zone.",
    location: "Location",
    locationHint: "Used for weather, sunrise, sunset, and moon phase. Save to apply your change.",
    locationSearch: "Search for a place",
    locationSearchButton: "Search",
    locationSearching: "Searching locations …",
    locationSelect: "Select",
    locationResults: "Location search results",
    locationNoResults: "No matching locations found.",
    locationAttribution: "Location search by Open-Meteo.com",
    locationChange: "Change location",
    locationRemove: "Remove location",
    locationRemoveTitle: "Remove location?",
    locationRemoveDescription: "The location will be removed from channel settings when you save.",
    cancel: "Cancel",
    locationSaveFailed: "Location could not be saved.",
    locationSearchFailed: "Locations could not be searched.",
    locationTimeZoneAction: "Use location time zone",
    locationTimeZoneTitle: "Sets the channel time zone to the location's time zone.",
    defaultChatTarget: "Default chat target",
    defaultChatTargetHint: "Used by entries that do not set their own chat target.",
  },
};

export const channelSettingsTexts = (language: "de" | "en"): ChannelSettingsTexts => texts[language];

const liveTexts: Readonly<Record<"de" | "en", LocationLiveTexts>> = {
  de: {
    weather: "Aktuelles Wetter",
    currentIn: (place) => `Jetzt in ${place}`,
    feelsLike: "gefühlt",
    wind: "Wind",
    updated: (minutes, time) => minutes < 1 ? `gerade aktualisiert · ${time}` : `aktualisiert vor ${String(minutes)} Min. · ${time}`,
    now: "Jetzt",
    duration: (hours, minutes) => `${String(hours)} Std. ${String(minutes)} Min.`,
    inDuration: (duration) => `in ${duration}`,
    providerError: "Wetterdienst gerade nicht erreichbar",
    temporaryError: "Daten konnten nicht geladen werden.",
    setLocation: "Standort festlegen",
    missingWeatherLocation: "Wetterdaten werden mit einem Kanalstandort angezeigt.",
    missingSunLocation: "Sonnenzeiten werden mit einem Kanalstandort angezeigt.",
    missingMoonLocation: "Mondphase und Aufgangszeiten werden mit einem Kanalstandort angezeigt.",
    sun: "Sonne heute",
    nextPhase: "Nächster Abschnitt",
    nextPhaseIn: (phase, duration) => `${phase} in ${duration}`,
    polarDay: "Polartag",
    polarNight: "Polarnacht",
    dawn: "Morgendämmerung",
    sunrise: "Sonnenaufgang",
    solarNoon: "Sonnenhöchststand",
    goldenHour: "Goldene Stunde",
    sunset: "Sonnenuntergang",
    blueHour: "Blaue Stunde",
    dusk: "Abenddämmerung",
    dayLength: "Tageslänge",
    moon: "Mond",
    illumination: (percent) => `${String(percent)} % beleuchtet`,
    moonrise: "Mondaufgang",
    moonset: "Monduntergang",
    nextRise: "Nächster Aufgang",
    commands: "Textbefehle aus Vorlage anlegen",
    commandDescription: "Die Vorlagen bleiben Entwürfe, bis du sie unter Textbefehle speicherst.",
    createCommand: "Anlegen",
    existingCommand: "Vorhanden",
    templates: [
      { name: "wetter", response: "In {weather.place} sind es {weather.temp} und es ist {weather.condition}. Gefühlt: {weather.feels_like}; Wind: {weather.wind}." },
      { name: "sonne", response: "Sonnenaufgang: {sun.rise}, Sonnenuntergang: {sun.set}. Tageslänge: {sun.day_length}." },
      { name: "mond", response: "Der Mond ist {moon.phase} und zu {moon.illumination}% beleuchtet. Aufgang: {moon.rise}." },
      { name: "goldenestunde", response: "Die goldene Stunde beginnt um {sun.golden_hour} und endet um {sun.golden_hour_end}." },
    ],
    variables: "Variablen",
    weatherModule: "Wetter",
    sunModule: "Sonne",
    moonModule: "Mond",
  },
  en: {
    weather: "Current weather",
    currentIn: (place) => `Now in ${place}`,
    feelsLike: "feels like",
    wind: "Wind",
    updated: (minutes, time) => minutes < 1 ? `just updated · ${time}` : `updated ${String(minutes)} min ago · ${time}`,
    now: "Now",
    duration: (hours, minutes) => `${String(hours)} hr ${String(minutes)} min`,
    inDuration: (duration) => `in ${duration}`,
    providerError: "Weather provider is unavailable",
    temporaryError: "Data could not be loaded.",
    setLocation: "Set location",
    missingWeatherLocation: "Weather details appear when a channel location is set.",
    missingSunLocation: "Sunrise and daylight times need a channel location.",
    missingMoonLocation: "Moon phase and rise times need a channel location.",
    sun: "Sun today",
    nextPhase: "Next phase",
    nextPhaseIn: (phase, duration) => `${phase} in ${duration}`,
    polarDay: "Polar day",
    polarNight: "Polar night",
    dawn: "Dawn",
    sunrise: "Sunrise",
    solarNoon: "Solar noon",
    goldenHour: "Golden hour",
    sunset: "Sunset",
    blueHour: "Blue hour",
    dusk: "Dusk",
    dayLength: "Day length",
    moon: "Moon",
    illumination: (percent) => `${String(percent)}% illuminated`,
    moonrise: "Moonrise",
    moonset: "Moonset",
    nextRise: "Next rise",
    commands: "Create a text command from a template",
    commandDescription: "Templates stay as drafts until you save them under Text commands.",
    createCommand: "Create",
    existingCommand: "Already exists",
    templates: [
      { name: "wetter", response: "In {weather.place} it is {weather.temp} and {weather.condition}. Feels like {weather.feels_like}; wind: {weather.wind}." },
      { name: "sonne", response: "Sunrise: {sun.rise}, sunset: {sun.set}. Day length: {sun.day_length}." },
      { name: "mond", response: "The moon is {moon.phase}, {moon.illumination}% illuminated. Rise: {moon.rise}." },
      { name: "goldenestunde", response: "Golden hour starts at {sun.golden_hour} and ends at {sun.golden_hour_end}." },
    ],
    variables: "Variables",
    weatherModule: "Weather",
    sunModule: "Sun",
    moonModule: "Moon",
  },
};

export const locationLiveTexts = (language: "de" | "en"): LocationLiveTexts => liveTexts[language];
