import { useEffect, useId, useState, type ReactElement } from "react";

export interface GamePickerGame {
  id: string;
  name: string;
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
}

interface GameSearchState {
  query: string;
  status: "loading" | "ready" | "error";
  results: GamePickerGame[];
}

export function GamePicker({ searchGames, value, onChange, messages, disabled = false }: {
  searchGames: (query: string) => Promise<readonly GamePickerGame[]>;
  value: readonly GamePickerGame[];
  onChange: (games: GamePickerGame[]) => void;
  messages: GamePickerMessages;
  disabled?: boolean;
}): ReactElement {
  const id = useId();
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<GameSearchState | null>(null);

  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setSearchState({ query: search, status: "loading", results: [] });
      searchGames(search)
        .then((games) => { if (active) setSearchState({ query: search, status: "ready", results: [...games] }); })
        .catch(() => { if (active) setSearchState({ query: search, status: "error", results: [] }); });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, searchGames]);

  const search = query.trim();
  const currentSearch = searchState?.query === search ? searchState : null;

  const add = (game: GamePickerGame): void => {
    if (value.some((entry) => entry.id === game.id)) return;
    onChange([...value, game]);
    setQuery("");
  };

  return (
    <div className="ui-game-picker">
      <label className="ui-game-picker__label" htmlFor={id}>{messages.label}</label>
      <p className="ui-game-picker__hint">{messages.hint}</p>
      <div className="ui-game-picker__selected" aria-live="polite">
        {value.map((game) => (
          <span className="ui-game-picker__chip" key={game.id}>
            <span>{game.name}</span>
            <button type="button" disabled={disabled} aria-label={messages.remove(game.name)} onClick={() => onChange(value.filter((entry) => entry.id !== game.id))}>×</button>
          </span>
        ))}
      </div>
      <input
        id={id}
        type="search"
        autoComplete="off"
        value={query}
        placeholder={messages.search}
        aria-describedby={`${id}-hint`}
        disabled={disabled}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <span className="ui-game-picker__sr-hint sr-only" id={`${id}-hint`}>{messages.searchHint}</span>
      {currentSearch?.status === "loading" ? <p className="ui-game-picker__status" role="status">{messages.loading}</p> : null}
      {currentSearch?.status === "error" ? <p className="form-error" role="alert">{messages.error}</p> : null}
      {search.length >= 2 && currentSearch?.status === "ready" && currentSearch.results.length === 0 ? <p className="ui-game-picker__status">{messages.empty}</p> : null}
      {currentSearch?.status !== "ready" || currentSearch.results.length === 0 ? null : (
        <ul className="ui-game-picker__results" role="listbox" aria-label={messages.label}>
          {currentSearch.results.map((game) => (
            <li key={game.id}>
              <button type="button" role="option" aria-selected={value.some((entry) => entry.id === game.id)} disabled={disabled || value.some((entry) => entry.id === game.id)} onClick={() => add(game)}>
                {game.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
