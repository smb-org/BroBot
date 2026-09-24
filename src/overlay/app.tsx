import { lazy, useEffect, useState, type ReactElement, type ReactNode } from "react";

const LazyOverlayShell = lazy(async () => {
  const module = await import("./shell");
  return { default: module.OverlayShell };
});

const LazyOverlayStatusView = lazy(async () => {
  const module = await import("./status");
  return { default: module.OverlayStatusView };
});

interface FragmentConfig {
  token: string | null;
  elementId: string | null;
  debug: boolean;
}

const readFragmentConfig = (): FragmentConfig => {
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const parameters = new URLSearchParams(fragment);
  const token = parameters.get("token");
  const elementId = parameters.get("element");
  return {
    token: token === null || token.length === 0 ? null : token,
    elementId: elementId === null || elementId.length === 0 ? null : elementId,
    debug: parameters.get("debug") === "1",
  };
};

const AppContent = ({ config }: { config: FragmentConfig }): ReactNode => {
  if (config.token !== null) return <LazyOverlayShell
    key={config.token}
    token={config.token}
    elementId={config.elementId}
    debug={config.debug}
  />;
  if (config.debug) return <LazyOverlayStatusView />;
  return null;
};

export const OverlayApp = (): ReactElement => {
  const [config, setConfig] = useState(readFragmentConfig);

  useEffect(() => {
    const handleHashChange = (): void => setConfig(readFragmentConfig());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  return <AppContent config={config} />;
};
