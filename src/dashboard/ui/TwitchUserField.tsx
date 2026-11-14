import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type ReactElement, type Ref } from "react";

import type { PanelTwitchUser, PanelTwitchUserSuggestionsResponse } from "../../panel-contract";
import { fetchTwitchUserSuggestions } from "../api";
import { dashboardLanguage, twitchUserFieldTexts, type DashboardLanguage } from "../locale";
import { FieldError } from "./FieldError";
import { Icon } from "./Icon";
import { InlineSuggestionPicker, InlineSuggestionPickerTarget, type InlineSuggestionGroup } from "./InlineSuggestionPicker";
import { Input } from "./primitives/input";

export interface TwitchUserFieldHandle {
  resolve: () => Promise<PanelTwitchUser | null>;
  clear: () => void;
}

export interface TwitchUserFieldProps {
  channelId?: string;
  label: string;
  hint: string;
  language?: DashboardLanguage;
  value: PanelTwitchUser | null;
  onChange: (user: PanelTwitchUser | null) => void;
  onLoginChange?: (login: string) => void;
  onLookupError?: (error: unknown) => void;
  loadSuggestions?: (query: string, signal: AbortSignal) => Promise<PanelTwitchUserSuggestionsResponse>;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  showLiveBadge?: boolean;
  error?: string;
  ref?: Ref<TwitchUserFieldHandle>;
}

const LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/u;
const normalizeLogin = (value: string): string => value.replace(/\s+/gu, "").replace(/^@/u, "");

export function TwitchUserField({
  channelId,
  label,
  hint,
  language = dashboardLanguage(),
  value,
  onChange,
  onLoginChange,
  onLookupError,
  loadSuggestions,
  placeholder,
  disabled = false,
  required = false,
  showLiveBadge = false,
  error,
  ref,
}: TwitchUserFieldProps): ReactElement {
  const id = useId();
  const inputId = `${id}-input`;
  const listboxId = `${id}-users`;
  const texts = twitchUserFieldTexts(language);
  const [login, setLogin] = useState(value?.login ?? "");
  const [users, setUsers] = useState<readonly PanelTwitchUser[]>([]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "searching" | "partial" | "error" | "not-found">("idle");
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const loginRef = useRef(login);
  const valueRef = useRef(value);

  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    if (value !== null) setLogin(value.login);
  }

  useEffect(() => {
    loginRef.current = login;
    valueRef.current = value;
  });

  const loader = useCallback((query: string, signal: AbortSignal): Promise<PanelTwitchUserSuggestionsResponse> => {
    if (loadSuggestions !== undefined) return loadSuggestions(query, signal);
    if (channelId === undefined) return Promise.resolve({ users: [], partial: false });
    return fetchTwitchUserSuggestions(channelId, query, signal);
  }, [channelId, loadSuggestions]);

  const abortActiveRequest = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => () => abortActiveRequest(), [abortActiveRequest]);

  const selectUser = (userLogin: string): void => {
    const user = users.find((candidate) => candidate.login === userLogin);
    if (user === undefined) return;
    abortActiveRequest();
    setLogin(user.login);
    loginRef.current = user.login;
    valueRef.current = user;
    onLoginChange?.(user.login);
    setStatus("idle");
    onChange(user);
    setOpen(false);
  };

  const resolve = useCallback(async (): Promise<PanelTwitchUser | null> => {
    const query = normalizeLogin(loginRef.current);
    setLogin(query);
    if (!LOGIN_PATTERN.test(query)) {
      valueRef.current = null;
      onChange(null);
      setStatus(query.length === 0 ? "idle" : "not-found");
      return null;
    }
    if (valueRef.current?.login.toLowerCase() === query.toLowerCase()) return valueRef.current;

    abortActiveRequest();
    const abort = new AbortController();
    abortRef.current = abort;
    const requestId = ++requestIdRef.current;
    setStatus("searching");
    try {
      const result = await loader(query, abort.signal);
      if (abort.signal.aborted || requestId !== requestIdRef.current) return null;
      setUsers(result.users.slice(0, 8));
      const exact = result.users.find((user) => user.login.toLowerCase() === query.toLowerCase()) ?? null;
      if (exact === null) {
        valueRef.current = null;
        onChange(null);
        setStatus(result.partial ? "partial" : "not-found");
        return null;
      }
      setLogin(exact.login);
      loginRef.current = exact.login;
      valueRef.current = exact;
      onLoginChange?.(exact.login);
      onChange(exact);
      setStatus(result.partial ? "partial" : "idle");
      return exact;
    } catch (caught: unknown) {
      if (abort.signal.aborted || requestId !== requestIdRef.current) return null;
      onLookupError?.(caught);
      valueRef.current = null;
      onChange(null);
      setStatus("error");
      return null;
    } finally {
      if (requestId === requestIdRef.current) abortRef.current = null;
    }
  }, [abortActiveRequest, loader, onChange, onLoginChange, onLookupError]);

  useImperativeHandle(ref, () => ({
    resolve,
    clear: () => {
      abortActiveRequest();
      requestIdRef.current += 1;
      setLogin("");
      loginRef.current = "";
      valueRef.current = null;
      onLoginChange?.("");
      setUsers([]);
      setOpen(false);
      setStatus("idle");
      onChange(null);
    },
  }), [abortActiveRequest, onChange, onLoginChange, ref, resolve]);

  const handleChange = (rawValue: string): void => {
    const next = normalizeLogin(rawValue);
    setLogin(next);
    loginRef.current = next;
    valueRef.current = null;
    onLoginChange?.(next);
    onChange(null);
    setStatus("idle");
    setUsers([]);
    abortActiveRequest();
    const requestId = ++requestIdRef.current;
    if (next.length < 2 || !/^[A-Za-z0-9_]+$/u.test(next)) {
      setOpen(false);
      return;
    }
    setStatus("searching");
    timerRef.current = setTimeout(() => {
      const abort = new AbortController();
      abortRef.current = abort;
      void loader(next, abort.signal).then((result) => {
        if (abort.signal.aborted || requestId !== requestIdRef.current) return;
        setUsers(result.users.slice(0, 8));
        setStatus(result.partial ? "partial" : "idle");
        setOpen(true);
      }).catch((error: unknown) => {
        if (abort.signal.aborted || requestId !== requestIdRef.current) return;
        onLookupError?.(error);
        setUsers([]);
        setStatus("error");
        setOpen(false);
      }).finally(() => {
        if (requestId === requestIdRef.current) abortRef.current = null;
      });
      timerRef.current = null;
    }, 250);
  };

  const groups: readonly InlineSuggestionGroup<PanelTwitchUser & { name: string }>[] = users.length === 0 ? [] : [{
    group: { id: "twitch-users", label: texts.suggestions, iconName: "member", order: 0 },
    options: users.map((user, index) => ({ option: { ...user, name: user.login }, index })),
  }];

  const statusText = status === "searching"
    ? texts.searching
    : status === "not-found" ? texts.notFound
    : status === "error" ? texts.lookupError
    : status === "partial" ? texts.partial
    : "";
  const statusIsError = status === "not-found" || status === "error";
  const isOpen = open && !disabled;

  return <InlineSuggestionPicker
    listboxId={listboxId}
    open={isOpen}
    groups={groups}
    messages={{ title: texts.suggestionTitle, noResults: texts.noSuggestions, keyHints: { navigate: texts.navigate, insert: texts.select, close: texts.close } }}
    onSelect={selectUser}
    onClose={() => setOpen(false)}
    renderOption={(user) => <>
      {user.profileImageUrl === null
        ? <span className="ui-twitch-user-field__avatar ui-twitch-user-field__avatar--empty"><Icon name="member" size={16} /></span>
        : <img className="ui-twitch-user-field__avatar" src={user.profileImageUrl} alt="" />}
      <span className="ui-template-text-field__suggestion-copy">
        <span className="ui-template-text-field__suggestion-name">{user.displayName}</span>
        <span className="ui-template-text-field__suggestion-token">@{user.login}</span>
      </span>
      {showLiveBadge && user.isLive === true ? <span className="ui-twitch-user-field__live">{texts.live}</span> : null}
    </>}
  >
    {({ activeOptionId, handleKeyDown }) => <div data-ui="" className="ui-twitch-user-field">
      <label className="ui-field__label" htmlFor={inputId}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      <InlineSuggestionPickerTarget>
        <div className="ui-twitch-user-field__anchor">
          <Input
            id={inputId}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={isOpen}
            aria-busy={status === "searching"}
            aria-controls={isOpen ? listboxId : undefined}
            aria-activedescendant={isOpen ? activeOptionId : undefined}
            aria-invalid={error !== undefined || statusIsError || undefined}
            aria-describedby={`${id}-hint ${id}-status`}
            autoComplete="off"
            spellCheck={false}
            required={required}
            disabled={disabled}
            placeholder={placeholder}
            value={login}
            onChange={(event) => handleChange(event.currentTarget.value)}
            onFocus={() => { if (users.length > 0) setOpen(true); }}
            onBlur={() => { void resolve(); }}
            onKeyDown={(event) => {
              if (handleKeyDown(event)) return;
              if (event.key === "Escape") {
                abortActiveRequest();
                setOpen(false);
                setStatus("idle");
              }
            }}
          />
        </div>
      </InlineSuggestionPickerTarget>
      <span id={`${id}-hint`} className="ui-field__description">{hint}</span>
      <div id={`${id}-status`} className="ui-twitch-user-field__status" aria-live="polite" aria-atomic="true">
        {error === undefined ? statusText : <FieldError className="ui-field__inline-error" message={error} />}
      </div>
    </div>}
  </InlineSuggestionPicker>;
}

