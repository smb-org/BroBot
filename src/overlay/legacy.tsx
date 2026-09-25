import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";

const LazyVariableOverlay = lazy(async () => {
  const module = await import("./variable");
  return { default: module.VariableOverlay };
});

interface LegacyOverlayConfig {
  token: string | null;
  name: string;
  text: string;
}

const readLegacyOverlayConfig = (): LegacyOverlayConfig | null => {
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const parameters = new URLSearchParams(fragment);
  const name = parameters.get("var");
  if (name === null) return null;
  const token = parameters.get("token");
  return {
    token: token === null || token.length === 0 ? null : token,
    name,
    text: parameters.get("text") ?? `${name}: {value}`,
  };
};

/** Keeps support for unbound links that still configure a single variable in the fragment. */
export const LegacyOverlayEntry = ({ onTokenBound }: { onTokenBound?: () => void }): ReactElement | null => {
  const [config, setConfig] = useState(readLegacyOverlayConfig);

  useEffect(() => {
    const handleHashChange = (): void => setConfig(readLegacyOverlayConfig());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  if (config === null) return null;
  return <Suspense fallback={null}>
    <LazyVariableOverlay
      key={`${config.token ?? ""}:${config.name}:${config.text}`}
      {...config}
      {...(onTokenBound === undefined ? {} : { onTokenBound })}
    />
  </Suspense>;
};
