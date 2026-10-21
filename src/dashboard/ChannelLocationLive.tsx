import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";

import { getChannelMoonToday, getChannelSunToday, getChannelWeatherCurrent } from "./api";
import type { PanelMoonToday, PanelSunToday, PanelWeatherCurrent } from "./api";
import { queryKeys } from "./data/keys";
import { dashboardLanguage } from "./locale";
import { locationLiveTexts } from "./channel-settings-locale";
import { Icon, Section, TokenChip, type IconName } from "./ui";
import { weatherModuleCatalog, WEATHER_CONDITION_LABELS } from "../modules/weather/contracts/catalog";
import { sunModuleCatalog } from "../modules/sun/contracts/catalog";
import { moonModuleCatalog } from "../modules/moon/contracts/catalog";
import { loadTextCommands } from "../modules/text_commands/panel/service";
import type { TextCommand } from "../modules/text_commands/contracts";
import type { WeatherCondition } from "../modules/weather/contracts";

const LIVE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const CLOCK_REFRESH_INTERVAL_MS = 60 * 1_000;

interface LiveCardProps {
  channelId: string;
  locationLoaded: boolean;
  hasLocation: boolean;
  locationRevision: number;
  timeZone: string;
}

const EMPTY_COMMANDS: readonly TextCommand[] = [];

export function ChannelLocationLiveCards({ channelId, locationLoaded, hasLocation, locationRevision, timeZone }: LiveCardProps): ReactElement {
  const language = dashboardLanguage();
  const texts = locationLiveTexts(language);
  const weatherQuery = useQuery({
    queryKey: queryKeys.module(channelId, "weather", `current:${String(locationRevision)}`),
    queryFn: ({ signal }) => getChannelWeatherCurrent(channelId, signal),
    enabled: hasLocation,
    refetchInterval: LIVE_REFRESH_INTERVAL_MS,
  });
  const sunQuery = useQuery({
    queryKey: queryKeys.module(channelId, "sun", `today:${String(locationRevision)}`),
    queryFn: ({ signal }) => getChannelSunToday(channelId, signal),
    enabled: hasLocation,
    refetchInterval: LIVE_REFRESH_INTERVAL_MS,
  });
  const moonQuery = useQuery({
    queryKey: queryKeys.module(channelId, "moon", `today:${String(locationRevision)}`),
    queryFn: ({ signal }) => getChannelMoonToday(channelId, signal),
    enabled: hasLocation,
    refetchInterval: LIVE_REFRESH_INTERVAL_MS,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => { setNow(Date.now()); }, CLOCK_REFRESH_INTERVAL_MS);
    return () => { window.clearInterval(interval); };
  }, []);

  const weather = weatherQuery.data?.status === "ok" ? weatherQuery.data : null;
  const sun = sunQuery.data?.status === "ok" ? sunQuery.data : null;
  const moon = moonQuery.data?.status === "ok" ? moonQuery.data : null;
  const missingLocation = (locationLoaded && !hasLocation) || weatherQuery.data?.status === "location_missing" ||
    sunQuery.data?.status === "location_missing" || moonQuery.data?.status === "location_missing";

  return <div className="channel-location-live-column">
    <Section title={texts.weather}>
      <WeatherCard
        data={weather}
        loading={!locationLoaded || (hasLocation && weatherQuery.isPending)}
        failed={weatherQuery.isError}
        providerFailed={weatherQuery.data?.status === "provider_error"}
        missingLocation={missingLocation}
        timeZone={timeZone}
        now={now}
        channelId={channelId}
      />
    </Section>
    <Section title={texts.sun}>
      <SunCard data={sun} loading={!locationLoaded || (hasLocation && sunQuery.isPending)} failed={sunQuery.isError}
        missingLocation={missingLocation} timeZone={timeZone} now={now} channelId={channelId} />
    </Section>
    <Section title={texts.moon}>
      <MoonCard data={moon} loading={!locationLoaded || (hasLocation && moonQuery.isPending)} failed={moonQuery.isError}
        missingLocation={missingLocation} timeZone={timeZone} now={now} channelId={channelId} />
    </Section>
  </div>;
}

export function ChannelLocationReference({
  channelId,
  onOpenCommand,
  onCreateCommand,
}: {
  channelId: string;
  onOpenCommand: (name: string) => void;
  onCreateCommand: (name: string, response: string) => void;
}): ReactElement {
  const language = dashboardLanguage();
  const texts = locationLiveTexts(language);
  const commandQuery = useQuery({
    queryKey: queryKeys.module(channelId, "text_commands", "command-list"),
    queryFn: () => loadTextCommands(channelId),
  });
  const commands = commandQuery.data ?? EMPTY_COMMANDS;
  const catalogs = useMemo(() => [
    { id: "weather", label: texts.weatherModule, values: weatherModuleCatalog[language].templateVariables },
    { id: "sun", label: texts.sunModule, values: sunModuleCatalog[language].templateVariables },
    { id: "moon", label: texts.moonModule, values: moonModuleCatalog[language].templateVariables },
  ], [language, texts.moonModule, texts.sunModule, texts.weatherModule]);

  return <div className="channel-location-reference-column">
    <Section title={texts.commands}>
      <p className="channel-location-reference__hint">{texts.commandDescription}</p>
      <div className="channel-location-command-list" aria-busy={commandQuery.isPending}>
        {texts.templates.map((template) => {
          const existing = commands.find((command) => command.name === template.name);
          return <div className="channel-location-command" key={template.name}>
            <div className="channel-location-command__copy">
              <strong className="mono">!{template.name}</strong>
              <span>{template.response}</span>
            </div>
            {commandQuery.isPending ? <span className="channel-location-command__action-placeholder" aria-hidden="true" /> : existing !== undefined
              ? <a className="channel-location-command__action" href={`/channels/${encodeURIComponent(channelId)}/modules/text_commands`}
                onClick={(event) => { event.preventDefault(); onOpenCommand(existing.name); }}>{texts.existingCommand}</a>
              : <button className="channel-location-command__action" type="button" disabled={commandQuery.isError}
                onClick={() => { onCreateCommand(template.name, template.response); }}>{texts.createCommand}</button>}
          </div>;
        })}
      </div>
    </Section>
    <Section title={texts.variables}>
      <div className="channel-location-variable-groups">
        {catalogs.map((catalog) => <div className="channel-location-variable-group" key={catalog.id}>
          <strong>{catalog.label}</strong>
          <div>{Object.entries(catalog.values).map(([name, variable]) => <TokenChip
            key={name}
            token={`{${name}}`}
            description={variable.description}
          />)}</div>
        </div>)}
      </div>
    </Section>
  </div>;
}

const WeatherCard = ({ data, loading, failed, providerFailed, missingLocation, timeZone, now, channelId }: {
  data: Extract<PanelWeatherCurrent, { status: "ok" }> | null;
  loading: boolean;
  failed: boolean;
  providerFailed: boolean;
  missingLocation: boolean;
  timeZone: string;
  now: number;
  channelId: string;
}): ReactElement => {
  const language = dashboardLanguage();
  const texts = locationLiveTexts(language);
  const displayData = missingLocation ? null : data;
  const weather = displayData?.weather;
  const condition = weather === undefined ? null : WEATHER_CONDITION_LABELS[language][weather.condition];
  const temp = displayData === null ? <LiveValueSkeleton size="temperature" /> : formatTemperature(displayData.weather.temperatureC, language, displayData.showFahrenheit);
  const feelsLike = displayData === null ? <LiveValueSkeleton size="short" /> : formatTemperature(displayData.weather.feelsLikeC, language, displayData.showFahrenheit);
  const wind = weather === undefined ? <LiveValueSkeleton /> : formatWind(weather.windSpeedMps, language);
  const updated = weather === undefined ? "—" : texts.updated(
    Math.max(0, Math.floor((now - Date.parse(weather.observedAt)) / 60_000)),
    formatTime(weather.observedAt, timeZone, language),
  );
  const iconName = weather === undefined ? "cloud" : weatherIcon(weather.condition, weather.isDay);
  const status = providerFailed ? texts.providerError : failed ? texts.temporaryError : null;

  return <div className="channel-location-weather-card channel-location-live-card" aria-busy={loading}>
    <div className="channel-location-live-card__reserve channel-location-live-card__layer" aria-hidden="true">
      <div className="channel-location-weather-card__heading">
        <span><LiveValueSkeleton size="wide" /></span>
        <Icon name="cloud" className="channel-location-weather-card__icon" size={20} />
      </div>
      <div className="channel-location-weather-card__temperature"><LiveValueSkeleton size="temperature" /></div>
      <div className="channel-location-weather-card__condition">
        <span><LiveValueSkeleton size="wide" /></span>
        <span><LiveValueSkeleton size="short" /></span>
      </div>
      <div className="channel-location-weather-card__footer">
        <span><Icon name="wind" size={16} /> <LiveValueSkeleton /></span>
        <span><LiveValueSkeleton size="wide" /></span>
      </div>
    </div>
    <div className="channel-location-live-card__content channel-location-live-card__layer" aria-hidden={missingLocation || undefined}>
      <div className="channel-location-weather-card__heading">
        <span>{displayData === null ? <LiveValueSkeleton size="wide" /> : texts.currentIn(displayData.location.name)}</span>
        <Icon name={iconName} className="channel-location-weather-card__icon" size={20} />
      </div>
      <div className="channel-location-weather-card__temperature">{temp}</div>
      <div className="channel-location-weather-card__condition">
        <span>{condition ?? <LiveValueSkeleton size="wide" />}</span>
        <span>{texts.feelsLike} {feelsLike}</span>
      </div>
      <div className="channel-location-weather-card__footer">
        <span><Icon name="wind" size={16} /> {texts.wind} {wind}</span>
        <span role={status === null ? undefined : "status"} title={status ?? undefined}>{status ?? (weather === undefined ? <LiveValueSkeleton size="wide" /> : updated)}</span>
      </div>
    </div>
    {missingLocation && <MissingLocation className="channel-location-live-card__empty" channelId={channelId} icon={iconName} message={texts.missingWeatherLocation} texts={texts} />}
  </div>;
};

const SunCard = ({ data, loading, failed, missingLocation, timeZone, now, channelId }: {
  data: Extract<PanelSunToday, { status: "ok" }> | null;
  loading: boolean;
  failed: boolean;
  missingLocation: boolean;
  timeZone: string;
  now: number;
  channelId: string;
}): ReactElement => {
  const language = dashboardLanguage();
  const texts = locationLiveTexts(language);
  const displayData = missingLocation ? null : data;
  const day = displayData?.day;
  const events = sunMarkers(displayData);
  const markerBounds = events.length < 2 ? null : [events[0]?.time ?? 0, events.at(-1)?.time ?? 0] as const;
  const hasEventRange = events.length >= 2;
  const nowPosition = markerBounds === null || markerBounds[1] <= markerBounds[0]
    ? localTimePosition(now, timeZone)
    : clampPercent(((now - markerBounds[0]) / (markerBounds[1] - markerBounds[0])) * 100);
  const nextEvent = events.find((event) => event.time > now) ?? (displayData?.nextDawnAt === null || displayData?.nextDawnAt === undefined
    ? undefined
    : { label: texts.dawn, time: Date.parse(displayData.nextDawnAt) });
  const dayLength = displayData === null ? <LiveValueSkeleton /> : day?.dayLengthMinutes === null || day?.dayLengthMinutes === undefined ? "—" : formatDuration(day.dayLengthMinutes, language);
  const readOnlyContent = day === undefined ? "—" : null;
  const message = failed ? texts.temporaryError : null;
  const nowBeforeDawn = markerBounds !== null && now < markerBounds[0];
  const nowAfterDusk = markerBounds !== null && now > markerBounds[1];
  const goldenHour = selectCurrentOrNextInterval(displayData?.goldenHourIntervals ?? [], now);
  const blueHour = selectCurrentOrNextInterval(displayData?.blueHourIntervals ?? [], now);

  const displayEvents = [
    { label: texts.dawn, at: day?.dawnAt, color: "var(--content-sun-dawn)" },
    { label: texts.sunrise, at: day?.sunriseAt, color: "var(--content-sun-sunrise)" },
    { label: texts.solarNoon, at: day?.solarNoonAt, color: "var(--content-sun-noon)" },
    { label: texts.goldenHour, at: goldenHour?.startAt, value: formatInterval(goldenHour, timeZone, language), color: "var(--content-sun-golden)" },
    { label: texts.sunset, at: day?.sunsetAt, color: "var(--content-sun-sunset)" },
    { label: texts.blueHour, at: blueHour?.startAt, value: formatInterval(blueHour, timeZone, language), color: "var(--content-sun-blue-hour)" },
    { label: texts.dusk, at: day?.duskAt, color: "var(--content-sun-dawn)" },
  ];

  return <div className="channel-location-sun-card channel-location-live-card" aria-busy={loading}>
    <div className="channel-location-live-card__reserve channel-location-live-card__layer" aria-hidden="true">
      <div className="channel-location-sun-card__heading"><Icon name="sun" size={16} /><span><LiveValueSkeleton size="wide" /></span></div>
      <div className="channel-location-sun-arc" aria-hidden="true">
        <div className="channel-location-sun-arc__line" />
        {events.map((event) => <span key={`${event.label}-${event.at}`} className="channel-location-sun-arc__point" title={`${event.label}: ${formatTime(event.at, timeZone, language)}`}
          style={{ "--position": `${String(markerPosition(event.time, markerBounds))}%`, "--phase-color": event.color } as CSSProperties} />)}
        <span className="channel-location-sun-arc__now" style={{ "--position": `${String(nowPosition)}%` } as CSSProperties} />
      </div>
      <div className="channel-location-sun-arc__labels">
        <span><LiveValueSkeleton size="short" /></span>
        <span><LiveValueSkeleton size="short" /></span>
        <span className={`channel-location-sun-arc__now-label${nowBeforeDawn ? " channel-location-sun-arc__now-label--start" : nowAfterDusk ? " channel-location-sun-arc__now-label--end" : ""}`}
          style={{ "--position": `${String(nowPosition)}%` } as CSSProperties}><LiveValueSkeleton size="wide" /></span>
      </div>
      <div className="channel-location-sun-next"><span><LiveValueSkeleton size="short" /></span><strong><LiveValueSkeleton size="wide" /></strong></div>
      <dl className="channel-location-sun-events">
        {displayEvents.map((event) => <div key={event.label}><dt><span style={{ "--phase-color": event.color } as CSSProperties} /><strong><LiveValueSkeleton size="short" /></strong></dt><dd className={`number${event.label === texts.goldenHour ? " channel-location-sun-events__interval channel-location-sun-events__interval--golden" : event.label === texts.blueHour ? " channel-location-sun-events__interval channel-location-sun-events__interval--blue" : ""}`}><LiveValueSkeleton /></dd></div>)}
        <div><dt><LiveValueSkeleton size="short" /></dt><dd className="number"><LiveValueSkeleton /></dd></div>
      </dl>
      <div className="channel-location-live-status" />
    </div>
    <div className="channel-location-live-card__content channel-location-live-card__layer" aria-hidden={missingLocation || undefined}>
      <div className="channel-location-sun-card__heading"><Icon name="sun" size={16} /><span>{day?.localDate ?? <LiveValueSkeleton size="wide" />}</span></div>
      <div className="channel-location-sun-arc" aria-label={texts.sun}>
      <div className="channel-location-sun-arc__line" />
      {events.map((event) => <span key={`${event.label}-${event.at}`} className="channel-location-sun-arc__point" title={`${event.label}: ${formatTime(event.at, timeZone, language)}`}
        style={{ "--position": `${String(markerPosition(event.time, markerBounds))}%`, "--phase-color": event.color } as CSSProperties} />)}
      <span className="channel-location-sun-arc__now" aria-label={texts.now}
        style={{ "--position": `${String(nowPosition)}%` } as CSSProperties} />
      </div>
      <div className="channel-location-sun-arc__labels">
        <span>{displayData === null ? <LiveValueSkeleton size="short" /> : hasEventRange ? formatTime(events[0]?.at, timeZone, language) : "—"}</span>
        <span>{displayData === null ? <LiveValueSkeleton size="short" /> : hasEventRange ? formatTime(events.at(-1)?.at, timeZone, language) : "—"}</span>
        <span className={`channel-location-sun-arc__now-label${nowBeforeDawn ? " channel-location-sun-arc__now-label--start" : nowAfterDusk ? " channel-location-sun-arc__now-label--end" : ""}`}
          style={{ "--position": `${String(nowPosition)}%` } as CSSProperties}>{texts.now} · {formatTime(new Date(now).toISOString(), timeZone, language)}</span>
      </div>
      <div className="channel-location-sun-next"><span>{texts.nextPhase}</span><strong>{displayData === null ? <LiveValueSkeleton size="wide" /> : day?.polarState === "day" ? texts.polarDay : day?.polarState === "night" ? texts.polarNight : nextEvent === undefined ? readOnlyContent : texts.nextPhaseIn(nextEvent.label, formatDuration(Math.ceil((nextEvent.time - now) / 60_000), language))}</strong></div>
      <dl className="channel-location-sun-events">
        {displayEvents.map((event) => <div key={event.label}><dt><span style={{ "--phase-color": event.color } as CSSProperties} />{event.label}</dt><dd className={`number${event.label === texts.goldenHour ? " channel-location-sun-events__interval channel-location-sun-events__interval--golden" : event.label === texts.blueHour ? " channel-location-sun-events__interval channel-location-sun-events__interval--blue" : ""}`}>{displayData === null ? <LiveValueSkeleton /> : "value" in event ? event.value : formatTime(event.at, timeZone, language)}</dd></div>)}
        <div><dt>{texts.dayLength}</dt><dd className="number">{dayLength}</dd></div>
      </dl>
      <div className="channel-location-live-status" {...(message === null ? {} : { role: "status" })}>{message}</div>
    </div>
    {missingLocation && <MissingLocation className="channel-location-live-card__empty" channelId={channelId} icon="sun" message={texts.missingSunLocation} texts={texts} />}
  </div>;
};

const MoonCard = ({ data, loading, failed, missingLocation, timeZone, now, channelId }: {
  data: Extract<PanelMoonToday, { status: "ok" }> | null;
  loading: boolean;
  failed: boolean;
  missingLocation: boolean;
  timeZone: string;
  now: number;
  channelId: string;
}): ReactElement => {
  const language = dashboardLanguage();
  const texts = locationLiveTexts(language);
  const displayData = missingLocation ? null : data;
  const phase = displayData === null ? <LiveValueSkeleton size="wide" /> : moonModuleCatalog[language].phases[displayData.phase] ?? displayData.phase;
  const nextRise = displayData?.nextRiseAt === null || displayData?.nextRiseAt === undefined
    ? displayData === null ? <LiveValueSkeleton /> : "—"
    : texts.inDuration(formatDuration(Math.ceil((Date.parse(displayData.nextRiseAt) - now) / 60_000), language));
  const message = failed ? texts.temporaryError : null;
  const fields = [
    { label: texts.moonrise, at: displayData?.riseAt },
    { label: texts.moonset, at: displayData?.setAt },
    { label: texts.nextRise, value: nextRise },
  ];

  return <div className="channel-location-moon-card channel-location-live-card" aria-busy={loading}>
    <div className="channel-location-live-card__reserve channel-location-live-card__layer" aria-hidden="true">
      <div className="channel-location-moon-card__phase"><Icon name="moon" size={20} /><strong><LiveValueSkeleton size="wide" /></strong><span><LiveValueSkeleton size="short" /></span></div>
      <dl className="channel-location-moon-events">
        {fields.map((field) => <div key={field.label}><dt><LiveValueSkeleton size="short" /></dt><dd className="number"><LiveValueSkeleton /></dd></div>)}
      </dl>
      <div className="channel-location-live-status" />
    </div>
    <div className="channel-location-live-card__content channel-location-live-card__layer" aria-hidden={missingLocation || undefined}>
      <div className="channel-location-moon-card__phase"><Icon name="moon" size={20} /><strong>{phase}</strong><span>{displayData === null ? <LiveValueSkeleton size="short" /> : texts.illumination(displayData.illumination)}</span></div>
      <dl className="channel-location-moon-events">
        {fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd className="number">{field.value ?? (displayData === null ? <LiveValueSkeleton /> : formatTime(field.at, timeZone, language))}</dd></div>)}
      </dl>
      <div className="channel-location-live-status" {...(message === null ? {} : { role: "status" })}>{message}</div>
    </div>
    {missingLocation && <MissingLocation className="channel-location-live-card__empty" channelId={channelId} icon="moon" message={texts.missingMoonLocation} texts={texts} />}
  </div>;
};

const MissingLocation = ({ channelId, icon, message, texts, className }: {
  channelId: string;
  icon: IconName;
  message: string;
  texts: ReturnType<typeof locationLiveTexts>;
  className: string;
}): ReactElement => <div className={`channel-location-live-empty channel-location-live-card__layer ${className}`} role="status">
  <Icon name={icon} size={20} aria-hidden="true" />
  <span>{message} <a href={`/channels/${encodeURIComponent(channelId)}/location-weather#location`}>{texts.setLocation}</a></span>
</div>;

const LiveValueSkeleton = ({ size = "default" }: { size?: "default" | "short" | "wide" | "temperature" }): ReactElement =>
  <span className={`channel-location-skeleton channel-location-skeleton--${size}`} aria-hidden="true" />;

const weatherIcon = (condition: WeatherCondition, isDay: boolean): IconName => {
  if (!isDay && (condition === "clear" || condition === "mostly_clear")) return "cloud-moon";
  switch (condition) {
    case "clear": return "sun";
    case "mostly_clear": return "cloud-sun";
    case "partly_cloudy": return "cloud-sun";
    case "cloudy": return "cloud";
    case "fog": return "cloud-fog";
    case "rain": return "cloud-rain";
    case "snow": return "cloud-snow";
    case "sleet": return "cloud-snow";
    case "thunderstorm": return "cloud-lightning";
    case "unknown": return "cloud";
  }
};

const formatTemperature = (value: number, language: "de" | "en", showFahrenheit: boolean): string => {
  const locale = language === "de" ? "de-DE" : "en-US";
  const celsius = `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} °C`;
  return showFahrenheit ? `${celsius} / ${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value * 9 / 5 + 32)} °F` : celsius;
};

const formatWind = (metersPerSecond: number, language: "de" | "en"): string => language === "de"
  ? `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(metersPerSecond * 3.6)} km/h`
  : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(metersPerSecond * 2.236936)} mph`;

const formatTime = (value: string | undefined | null, timeZone: string, language: "de" | "en"): string => value === undefined || value === null
  ? "—"
  : new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(Date.parse(value));

const formatInterval = (interval: { startAt: string; endAt: string } | undefined, timeZone: string, language: "de" | "en"): string => interval === undefined
  ? "—"
  : `${formatTime(interval.startAt, timeZone, language)}–${formatTime(interval.endAt, timeZone, language)}`;

const formatDuration = (minutes: number, language: "de" | "en"): string => {
  const safeMinutes = Math.max(0, minutes);
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  return locationLiveTexts(language).duration(hours, remainder);
};

const sunMarkers = (data: Extract<PanelSunToday, { status: "ok" }> | null): { label: string; at: string; time: number; color: string }[] => {
  if (data === null) return [];
  const language = dashboardLanguage();
  const texts = locationLiveTexts(language);
  const values = [
    { label: texts.dawn, at: data.day.dawnAt, color: "var(--content-sun-dawn)" },
    { label: texts.sunrise, at: data.day.sunriseAt, color: "var(--content-sun-sunrise)" },
    { label: texts.solarNoon, at: data.day.solarNoonAt, color: "var(--content-sun-noon)" },
    ...data.goldenHourIntervals.map((interval) => ({ label: texts.goldenHour, at: interval.startAt, color: "var(--content-sun-golden)" })),
    { label: texts.sunset, at: data.day.sunsetAt, color: "var(--content-sun-sunset)" },
    ...data.blueHourIntervals.map((interval) => ({ label: texts.blueHour, at: interval.startAt, color: "var(--content-sun-blue-hour)" })),
    { label: texts.dusk, at: data.day.duskAt, color: "var(--content-sun-dawn)" },
  ];
  const markers: { label: string; at: string; time: number; color: string }[] = [];
  for (const event of values) {
    if (typeof event.at !== "string") continue;
    const time = Date.parse(event.at);
    if (Number.isFinite(time)) markers.push({ ...event, at: event.at, time });
  }
  return markers.sort((left, right) => left.time - right.time);
};

const selectCurrentOrNextInterval = <Interval extends { startAt: string; endAt: string }>(
  intervals: readonly Interval[],
  now: number,
): Interval | undefined => {
  const valid = intervals.filter((interval) => Number.isFinite(Date.parse(interval.startAt)) && Number.isFinite(Date.parse(interval.endAt)))
    .slice()
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
  return valid.find((interval) => Date.parse(interval.startAt) <= now && Date.parse(interval.endAt) >= now)
    ?? valid.find((interval) => Date.parse(interval.startAt) > now)
    ?? valid.at(-1);
};

const localTimePosition = (now: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return clampPercent(((hour * 60 + minute) / (24 * 60)) * 100);
};

const markerPosition = (time: number, bounds: readonly [number, number] | null): number =>
  bounds === null || bounds[1] <= bounds[0] ? 50 : clampPercent(((time - bounds[0]) / (bounds[1] - bounds[0])) * 100);

const clampPercent = (value: number): number => Math.max(2, Math.min(98, value));
