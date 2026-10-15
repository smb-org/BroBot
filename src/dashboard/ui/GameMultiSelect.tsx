import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { ImageOff } from "lucide-react";

import { PopoverPrimitive } from "./primitives/popover";
import { FieldError } from "./FieldError";

export interface GameMultiSelectGame {
  id: string;
  name: string;
  boxArtUrlTemplate?: string;
}

export interface GameMultiSelectMessages {
  label: string;
  hint: string;
  search: string;
  searchHint: string;
  loading: string;
  empty: string;
  error: string;
  suggestions: string;
  allGames: string;
  limitReached: string;
  selectedCount: (count: number, maximum: number) => string;
  remove: (name: string) => string;
}

const DEFAULT_MAXIMUM = 10;
const GAME_LOOKUP_RETRY_DELAY_MS = 30_000;

const coverUrl = (game: GameMultiSelectGame, width: number, height: number): string | null => {
  if (game.boxArtUrlTemplate === undefined) return null;
  const url = game.boxArtUrlTemplate.replaceAll("{width}", String(width)).replaceAll("{height}", String(height));
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "static-cdn.jtvnw.net" ? url : null;
  } catch {
    return null;
  }
};

const GameCover = ({ game, width, height }: { game: GameMultiSelectGame; width: number; height: number }): ReactElement => {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : coverUrl(game, width, height);
  return src === null
    ? <span className="ui-game-multi-select__cover-placeholder" aria-hidden="true" style={{ width, height }}><ImageOff size={Math.min(width - 4, 18)} /></span>
    : <img
      className="ui-game-multi-select__cover"
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
  results: GameMultiSelectGame[];
}

export interface GameMultiSelectProps {
  searchGames: (query: string) => Promise<readonly GameMultiSelectGame[]>;
  lookupGames?: (ids: readonly string[]) => Promise<readonly GameMultiSelectGame[]>;
  value: readonly GameMultiSelectGame[];
  onChange: (games: GameMultiSelectGame[]) => void;
  messages: GameMultiSelectMessages;
  disabled?: boolean;
  visuallyHiddenLabel?: boolean;
  compact?: boolean;
  maximum?: number;
  error?: string;
}

/** Async Twitch game search with channel suggestions and a configurable selection cap. */
export function GameMultiSelect({ searchGames, lookupGames, value, onChange, messages, disabled = false, visuallyHiddenLabel = false, compact = false, maximum = DEFAULT_MAXIMUM, error }: GameMultiSelectProps): ReactElement {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ignoreNextInputFocusRef = useRef(false);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<GameSearchState | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [artworkById, setArtworkById] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [lookupRetryNonce, setLookupRetryNonce] = useState(0);
  const lookedUpIds = useRef(new Set<string>());

  useEffect(() => {
    if (!resultsOpen) return;
    const isInsidePicker = (node: Node | null): boolean => node !== null &&
      (rootRef.current?.contains(node) === true || popupRef.current?.contains(node) === true);
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!isInsidePicker(event.target as Node | null)) setResultsOpen(false);
    };
    const closeOnFocusExit = (event: FocusEvent): void => {
      if (!isInsidePicker(event.relatedTarget as Node | null)) setResultsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("focusout", closeOnFocusExit, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("focusout", closeOnFocusExit, true);
    };
  }, [resultsOpen]);

  useEffect(() => {
    const lookedUpIdsForEffect = lookedUpIds.current;
    if (lookupGames === undefined) return;
    const ids = value.flatMap((game) => game.boxArtUrlTemplate === undefined && !lookedUpIdsForEffect.has(game.id) ? [game.id] : []);
    if (ids.length === 0) return;
    ids.forEach((gameId) => lookedUpIdsForEffect.add(gameId));
    let active = true;
    let settled = false;
    let retryTimer: number | undefined;
    lookupGames(ids)
      .then((games) => {
        settled = true;
        if (!active) return;
        const fetchedArtwork = new Map(games.flatMap((game) => game.boxArtUrlTemplate === undefined ? [] : [[game.id, game.boxArtUrlTemplate] as const]));
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

  const search = query.trim();
  useEffect(() => {
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
  }, [search, resultsOpen, searchGames]);

  const currentSearch = searchState?.query === search ? searchState : null;
  const results = currentSearch?.status === "ready" ? currentSearch.results : [];
  const selectedIds = new Set(value.map(({ id: gameId }) => gameId));
  const availableResults = results;
  const atLimit = value.length >= maximum;

  const displayedGame = (game: GameMultiSelectGame): GameMultiSelectGame => {
    const boxArtUrlTemplate = artworkById.get(game.id);
    return game.boxArtUrlTemplate === undefined && boxArtUrlTemplate !== undefined ? { ...game, boxArtUrlTemplate } : game;
  };

  const add = (game: GameMultiSelectGame): void => {
    if (disabled || atLimit || selectedIds.has(game.id)) return;
    onChange([...value, game]);
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const remove = (gameId: string): void => {
    if (disabled) return;
    onChange(value.filter((game) => game.id !== gameId));
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setResultsOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!resultsOpen || availableResults.length === 0) return;
      event.preventDefault();
      const next = event.key === "ArrowDown"
        ? (activeIndex + 1) % availableResults.length
        : (activeIndex - 1 + availableResults.length) % availableResults.length;
      setActiveIndex(next);
      optionRefs.current[next]?.focus();
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setResultsOpen(false);
      ignoreNextInputFocusRef.current = true;
      inputRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = event.key === "ArrowDown"
      ? (index + 1) % availableResults.length
      : (index - 1 + availableResults.length) % availableResults.length;
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  };

  const status = currentSearch?.status === "error" ? "error"
    : currentSearch?.status === "ready" ? results.length === 0 ? "empty" : "ready"
      : search.length === 1 ? "short-query" : "loading";

  return (
    <PopoverPrimitive.Root open={resultsOpen} onOpenChange={setResultsOpen}>
      <div data-ui="" className={`ui-game-multi-select${compact ? " ui-game-multi-select--compact" : ""}`} ref={rootRef}>
        <label className={`ui-game-multi-select__label${visuallyHiddenLabel ? " sr-only" : ""}`} htmlFor={id}>{messages.label}</label>
        <p className="ui-game-multi-select__hint">{messages.hint}</p>
        <div className="ui-game-multi-select__selected" aria-live="polite">
          {value.map((game) => {
            const gameForDisplay = displayedGame(game);
            return (
              <span className="ui-game-multi-select__chip" key={game.id}>
                <GameCover game={gameForDisplay} width={compact ? 16 : 20} height={compact ? 21 : 27} />
                <span className="ui-game-multi-select__chip-name">{game.name}</span>
                <button type="button" disabled={disabled} aria-label={messages.remove(game.name)} onClick={() => remove(game.id)}>×</button>
              </span>
            );
          })}
        </div>
        <div className="ui-game-multi-select__search">
          <input
            data-ui=""
            className="ui-game-multi-select__input"
            ref={inputRef}
            id={id}
            type="search"
            autoComplete="off"
            value={query}
            placeholder={atLimit ? messages.selectedCount(value.length, maximum) : value.length === 0 ? messages.allGames : messages.search}
            aria-describedby={`${id}-hint${error === undefined ? "" : ` ${id}-error`}`}
            aria-invalid={error === undefined ? undefined : true}
            aria-label={messages.label}
            aria-controls={`${id}-results`}
            aria-expanded={resultsOpen}
            aria-haspopup="listbox"
            disabled={disabled || atLimit}
            onFocus={() => {
              if (ignoreNextInputFocusRef.current) {
                ignoreNextInputFocusRef.current = false;
                return;
              }
              setResultsOpen(true);
            }}
            onClick={() => setResultsOpen(true)}
            onKeyDown={handleInputKeyDown}
            onChange={(event) => { setQuery(event.currentTarget.value); setActiveIndex(0); setResultsOpen(true); }}
          />
        </div>
        <p className="ui-game-multi-select__limit-message" aria-live="polite">{atLimit ? messages.limitReached : ""}</p>
        {error === undefined ? null : <FieldError id={`${id}-error`} className="ui-game-multi-select__error" message={error} />}
        <span className="ui-game-multi-select__sr-hint sr-only" id={`${id}-hint`}>{messages.searchHint}</span>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Positioner anchor={inputRef} side="bottom" align="start" sideOffset={4} className="ui-game-multi-select__positioner" style={{ zIndex: "var(--layer-popover)" }}>
            <PopoverPrimitive.Popup
              ref={popupRef}
              role="dialog"
              aria-label={messages.label}
              initialFocus={false}
              className="ui-game-multi-select__popup"
            >
              <div className="ui-game-multi-select__status" role="status" aria-live="polite" aria-busy={status === "loading"}>
                {status === "loading" ? messages.loading : status === "short-query" ? messages.searchHint : ""}
              </div>
              <div className="ui-game-multi-select__results" id={`${id}-results`} role="listbox" aria-label={status === "ready" && search.length === 0 ? messages.suggestions : messages.label}>
                {status === "error" ? <p className="ui-game-multi-select__empty form-error" role="alert">{messages.error}</p> : null}
                {status === "empty" ? <p className="ui-game-multi-select__empty">{messages.empty}</p> : null}
                {status === "ready" && search.length === 0 && availableResults.length > 0
                  ? <p className="ui-game-multi-select__group-label">{messages.suggestions}</p>
                  : null}
                {status === "ready" ? availableResults.map((game, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedIds.has(game.id)}
                    className="ui-game-multi-select__option"
                    key={game.id}
                    ref={(element) => { optionRefs.current[index] = element; }}
                    tabIndex={0}
                    disabled={disabled || (atLimit && !selectedIds.has(game.id)) || selectedIds.has(game.id)}
                    onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    onClick={() => add(game)}
                  >
                    <GameCover game={game} width={28} height={38} />
                    <span className="ui-game-multi-select__name">{game.name}</span>
                  </button>
                )) : null}
              </div>
              <div className="ui-game-multi-select__footer">
                <span>{messages.hint}</span>
                <span aria-live="polite">{messages.selectedCount(value.length, maximum)}</span>
              </div>
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      </div>
    </PopoverPrimitive.Root>
  );
}
