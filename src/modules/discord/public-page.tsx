import { useEffect, useState, type ReactElement } from "react";

import { Icon } from "../../dashboard/ui";
import "../../dashboard/ui/tokens.css";
import "./public-page.css";
import { discordCatalog, type DiscordLanguage } from "./locale";

interface DiscordLinkViewModel {
  discordUsername: string;
  twitchLogin: string;
  linkedAt: string;
}

export type DiscordLinkPageState =
  | { kind: "loading" }
  | { kind: "not_configured" }
  | { kind: "signed_out" }
  | { kind: "no_twitch" }
  | { kind: "error" }
  | { kind: "linked"; link: DiscordLinkViewModel };

interface DiscordLinkResponse {
  configured: boolean;
  signedIn: boolean;
  csrfToken?: string;
  link: DiscordLinkViewModel | null;
}

const languageForPage = (): DiscordLanguage => {
  const requested = new URLSearchParams(window.location.search).get("lang");
  if (requested === "de" || requested === "en") return requested;
  return (navigator.languages[0] ?? navigator.language).toLowerCase().startsWith("de") ? "de" : "en";
};

interface DiscordLinkViewProps {
  language: DiscordLanguage;
  state: DiscordLinkPageState;
  unlinking?: boolean;
  unlinkError?: boolean;
  onUnlink?: () => void;
}

export const DiscordLinkView = ({ language, state, unlinking = false, unlinkError = false, onUnlink }: DiscordLinkViewProps): ReactElement => {
  const text = discordCatalog[language];
  const dateFormatter = new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", { dateStyle: "medium" });
  const linkedAt = state.kind === "linked" && Number.isFinite(Date.parse(state.link.linkedAt))
    ? dateFormatter.format(new Date(state.link.linkedAt))
    : "";

  return <main className="discord-public" data-ui="discord-public">
    <article className="discord-public__card">
      <header className="discord-public__header">
        <span className="discord-public__mark" aria-hidden="true"><Icon name="link" size={20} /></span>
        <div>
          <p className="discord-public__eyebrow">BroBot</p>
          <h1>{text.pageTitle}</h1>
        </div>
      </header>
      <p className="discord-public__intro">{text.introduction}</p>
      <section className="discord-public__state" aria-live="polite" data-state={state.kind}>
        {state.kind === "loading" ? <div className="discord-public__placeholder" aria-label={language === "de" ? "Laden" : "Loading"} /> : null}
        {state.kind === "not_configured" ? <div className="discord-public__message">
          <h2>{text.notAvailableTitle}</h2>
          <p>{text.notAvailableDescription}</p>
        </div> : null}
        {state.kind === "signed_out" ? <div className="discord-public__message">
          <h2>{text.signInTitle}</h2>
          <p>{text.signInDescription}</p>
          <a className="discord-public__button discord-public__button--primary" href="/auth/discord">
            <Icon name="shield-check" />{text.signIn}
          </a>
        </div> : null}
        {state.kind === "no_twitch" ? <div className="discord-public__message">
          <h2>{text.noTwitchTitle}</h2>
          <p>{text.noTwitchDescription}</p>
          <a className="discord-public__button discord-public__button--primary" href="/auth/discord">
            <Icon name="reload" />{text.retry}
          </a>
        </div> : null}
        {state.kind === "error" ? <div className="discord-public__message">
          <h2>{text.errorTitle}</h2>
          <p>{text.errorDescription}</p>
          <a className="discord-public__button discord-public__button--primary" href="/auth/discord">
            <Icon name="reload" />{text.retry}
          </a>
        </div> : null}
        {state.kind === "linked" ? <div className="discord-public__message discord-public__message--linked">
          <h2><span className="discord-public__status-dot" aria-hidden="true" />{text.linkedTitle}</h2>
          <dl className="discord-public__details">
            <div><dt>{text.discordAccount}</dt><dd title={state.link.discordUsername}>{state.link.discordUsername}</dd></div>
            <div><dt>{text.twitchAccount}</dt><dd title={`@${state.link.twitchLogin}`}>@{state.link.twitchLogin}</dd></div>
            <div><dt>{text.linkedSince}</dt><dd>{linkedAt}</dd></div>
          </dl>
          <p className="discord-public__error" role={unlinkError ? "alert" : undefined}>{unlinkError ? text.unlinkError : "\u00a0"}</p>
          <button className="discord-public__button discord-public__button--neutral" type="button" disabled={unlinking} onClick={onUnlink}>
            <Icon name="unlink" />{text.unlink}
          </button>
        </div> : null}
      </section>
      <footer className="discord-public__footer">{text.footer}</footer>
    </article>
  </main>;
};

export const DiscordLinkPage = (): ReactElement => {
  const language = languageForPage();
  const [state, setState] = useState<DiscordLinkPageState>({ kind: "loading" });
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/discord/link", { headers: { Accept: "application/json" } })
      .then(async (response): Promise<DiscordLinkResponse> => {
        if (!response.ok) throw new Error("discord_link_state_unavailable");
        return await response.json();
      })
      .then((payload) => {
        if (!active) return;
        if (!payload.configured) {
          setState({ kind: "not_configured" });
          return;
        }
        if (payload.signedIn && payload.link !== null) {
          setCsrfToken(payload.csrfToken ?? null);
          setState({ kind: "linked", link: payload.link });
          return;
        }
        const status = new URLSearchParams(window.location.search).get("discord");
        setState(status === "no-twitch" ? { kind: "no_twitch" } : status === "error" ? { kind: "error" } : { kind: "signed_out" });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => { active = false; };
  }, []);

  const unlink = async (): Promise<void> => {
    if (csrfToken === null || unlinking) return;
    setUnlinking(true);
    setUnlinkError(false);
    try {
      const response = await fetch("/api/discord/unlink", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
      });
      if (!response.ok) throw new Error("discord_unlink_failed");
      setCsrfToken(null);
      setState({ kind: "signed_out" });
    } catch {
      setUnlinkError(true);
    } finally {
      setUnlinking(false);
    }
  };

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.palette = "nachtschicht";
    document.title = discordCatalog[language].pageTitle;
  }, [language]);

  return <DiscordLinkView language={language} state={state} unlinking={unlinking} unlinkError={unlinkError} onUnlink={() => { void unlink(); }} />;
};
