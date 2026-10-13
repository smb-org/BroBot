import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { LoadState } from "./LoadState";
import { LoadStateLines } from "./LoadState";

export interface GamePickerGame {
  id: string;
  name: string;
  boxArtUrlTemplate?: string;
}

export interface GamePickerMessages {
  label: string;
  hint: string;
  search: string;
  searchHint: string;
  loading: string;
  empty: string;
  error: string;
  remove: (name: string) => string;
  selectedCount?: (count: number) => string;
  clearSelection?: string;
}

const GAME_LOOKUP_RETRY_DELAY_MS = 30_000;

const coverUrl = (game: GamePickerGame, width: number, height: number): string | null => {
  if (game.boxArtUrlTemplate === undefined) return null;
  const url = game.boxArtUrlTemplate.replaceAll("{width}", String(width)).replaceAll("{height}", String(height));
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "static-cdn.jtvnw.net" ? url : null;
  } catch {
    return null;
  }
};

const GameCover = ({ game, width, height }: { game: GamePickerGame; width: number; height: number }): ReactElement => {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : coverUrl(game, width, height);
  return src === null
    ? <span className="ui-game-picker__cover-placeholder" aria-hidden="true" style={{ width, height }} />
    : <img
      className="ui-game-picker__cover"
      src={src}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      alt=""
      onError={() => setFailed(true)}
    />;
};

interface GameSearchState {
  query: string;
  status: "loading" | "ready" | "error";
  results: GamePickerGame[];
}

export function GamePicker({ searchGames, lookupGames, value, onChange, messages, disabled = false, visuallyHiddenLabel = false, compact = false }: {
  searchGames: (query: string) => Promise<readonly GamePickerGame[]>;
  lookupGames?: (ids: readonly string[]) => Promise<readonly GamePickerGame[]>;
  value: readonly GamePickerGame[];
  onChange: (games: GamePickerGame[]) => void;
  messages: GamePickerMessages;
  disabled?: boolean;
  visuallyHiddenLabel?: boolean;
  compact?: boolean;
}): ReactElement {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<GameSearchState | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [artworkById, setArtworkById] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [lookupRetryNonce, setLookupRetryNonce] = useState(0);

  const lookedUpIds = useRef(new Set<string>());

  useEffect(() => {
    const lookedUpIdsForEffect = lookedUpIds.current;
    if (lookupGames === undefined) return;
    const ids = value.flatMap((game) => game.boxArtUrlTemplate === undefined && !lookedUpIdsForEffect.has(game.id)
      ? [game.id]
      : []);
    if (ids.length === 0) return;
    ids.forEach((gameId) => lookedUpIdsForEffect.add(gameId));
    let active = true;
    let settled = false;
    let retryTimer: number | undefined;
    lookupGames(ids)
      .then((games) => {
        settled = true;
        if (!active) return;
        const fetchedArtwork = new Map(games.flatMap((game) => game.boxArtUrlTemplate === undefined
          ? []
          : [[game.id, game.boxArtUrlTemplate] as const]));
        if (fetchedArtwork.size === 0) return;
        setArtworkById((current) => {
          let changed = false;
          const next = new Map(current);
          for (const [gameId, boxArtUrlTemplate] of fetchedArtwork) {
            if (next.get(gameId) === boxArtUrlTemplate) continue;
            changed = true;
            next.set(gameId, boxArtUrlTemplate);
          }
          return changed ? next : current;
        });
      })
      .catch(() => {
        settled = true;
        if (!active) return;
        ids.forEach((gameId) => lookedUpIdsForEffect.delete(gameId));
        retryTimer = window.setTimeout(() => {
          if (active) setLookupRetryNonce((nonce) => nonce + 1);
        }, GAME_LOOKUP_RETRY_DELAY_MS);
      });
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (!settled) ids.forEach((gameId) => lookedUpIdsForEffect.delete(gameId));
    };
  }, [value, lookupGames, lookupRetryNonce]);

  useEffect(() => {
    const search = query.trim();
    if (!resultsOpen || (search.length > 0 && search.length < 2)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setSearchState({ query: search, status: "loading", results: [] });
      searchGames(search)
        .then((games) => { if (active) setSearchState({ query: search, status: "ready", results: [...games] }); })
        .catch(() => { if (active) setSearchState({ query: search, status: "error", results: [] }); });
    }, search.length === 0 ? 0 : 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, resultsOpen, searchGames]);

  const search = query.trim();
  const showResults = resultsOpen && (search.length === 0 || search.length >= 2);
  const currentSearch = searchState?.query === search ? searchState : null;
  const searchStatus = search.length === 1 ? "empty" : currentSearch?.status === "error" ? "error"
    : currentSearch?.status === "ready" ? currentSearch.results.length === 0 ? "empty" : "success"
      : "loading";

  useEffect(() => {
    if (!showResults) return;
    const dismissOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setResultsOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => { document.removeEventListener("pointerdown", dismissOutside); };
  }, [showResults]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const closeOnFocusLeave = (event: FocusEvent): void => {
      if (!root.contains(event.relatedTarget as Node | null)) setResultsOpen(false);
    };
    root.addEventListener("focusout", closeOnFocusLeave);
    return () => { root.removeEventListener("focusout", closeOnFocusLeave); };
  }, []);

  const closeOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setResultsOpen(false);
    }
  };
  const add = (game: GamePickerGame): void => {
    if (value.some((entry) => entry.id === game.id)) return;
    onChange([...value, game]);
    setQuery("");
    setResultsOpen(false);
  };
  const displayedGame = (game: GamePickerGame): GamePickerGame => {
    const boxArtUrlTemplate = artworkById.get(game.id);
    return game.boxArtUrlTemplate === undefined && boxArtUrlTemplate !== undefined
      ? { ...game, boxArtUrlTemplate }
      : game;
  };
  const selectionSummary = messages.selectedCount?.(value.length) ?? `${String(value.length)} selected`;

  return (
    <div data-ui="" className={`ui-game-picker${compact ? " ui-game-picker--compact" : ""}`} ref={rootRef}>
      <label className={`ui-game-picker__label${visuallyHiddenLabel ? " sr-only" : ""}`} htmlFor={id}>{messages.label}</label>
      <p className="ui-game-picker__hint">{messages.hint}</p>
      <div className="ui-game-picker__selected" aria-live="polite">
        {compact
          ? value.length === 0 ? null : <button className="ui-game-picker__compact-selection" type="button" disabled={disabled}
            aria-label={`${messages.clearSelection ?? messages.label} (${selectionSummary})`}
            title={value.map((game) => game.name).join(", ")} onClick={() => onChange([])}>
            <span className="mono">{String(value.length)}</span>
            <span className="sr-only">{selectionSummary}</span>
          </button>
          : value.map((game) => {
            const gameForDisplay = displayedGame(game);
            return (
              <span className="ui-game-picker__chip" key={game.id}>
                <GameCover game={gameForDisplay} width={20} height={27} />
                <span>{game.name}</span>
                <button type="button" disabled={disabled} aria-label={messages.remove(game.name)} onClick={() => onChange(value.filter((entry) => entry.id !== game.id))}>×</button>
              </span>
            );
          })}
      </div>
      <div className="ui-game-picker__search">
        <input
          id={id}
          type="search"
          autoComplete="off"
          value={query}
          placeholder={messages.search}
          aria-describedby={`${id}-hint`}
          disabled={disabled}
          onFocus={() => setResultsOpen(true)}
          onKeyDown={closeOnEscape}
          onChange={(event) => { setQuery(event.currentTarget.value); setResultsOpen(true); }}
        />
        {!showResults ? null : <div className="ui-game-picker__results-slot">
          <LoadState
            variant="panel-220"
            status={searchStatus}
            loading={<div role="status"><LoadStateLines rows={3} height={54} /><span className="sr-only">{messages.loading}</span></div>}
            empty={<p className="ui-game-picker__status">{messages.empty}</p>}
            error={<p className="form-error" role="alert">{messages.error}</p>}
          >
            <ul className="ui-game-picker__results" role="listbox" aria-label={messages.label}>
              {currentSearch?.status === "ready" ? currentSearch.results.map((game) => (
                <li key={game.id}>
                  <button type="button" role="option" aria-selected={value.some((entry) => entry.id === game.id)} disabled={disabled || value.some((entry) => entry.id === game.id)} onKeyDown={closeOnEscape} onClick={() => add(game)}>
                    <GameCover game={game} width={28} height={38} />
                    {game.name}
                  </button>
                </li>
              )) : null}
            </ul>
          </LoadState>
        </div>}
      </div>
      <span className="ui-game-picker__sr-hint sr-only" id={`${id}-hint`}>{messages.searchHint}</span>
    </div>
  );
}
