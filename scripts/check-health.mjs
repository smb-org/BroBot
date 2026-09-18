import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const maxAttempts = 6;
const requestTimeoutMs = 30_000;
const defaultRetryDelayMs = 2_000;

const retryDelayMs = (() => {
  const configured = Number(process.env.CHECK_HEALTH_RETRY_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : defaultRetryDelayMs;
})();

const invalidRouteError = (environment, reason, cause) => new Error(
  `Konfiguration wrangler.jsonc bzw. die aufgelöste Healthcheck-Route für ${environment} ist ungültig: ${reason}`,
  cause === undefined ? undefined : { cause },
);

const validateDeploymentUrl = (url, environment) => {
  if (url.protocol !== "https:") {
    throw invalidRouteError(environment, "Das Schema muss https: sein.");
  }
  if (url.username !== "" || url.password !== "") {
    throw invalidRouteError(environment, "Benutzername und Passwort sind nicht erlaubt.");
  }
  if (url.hostname === "") {
    throw invalidRouteError(environment, "Der Hostname darf nicht leer sein.");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw invalidRouteError(environment, "Ein Pfad ist nicht erlaubt.");
  }
  if (url.search !== "") {
    throw invalidRouteError(environment, "Eine Query ist nicht erlaubt.");
  }
  if (url.hash !== "") {
    throw invalidRouteError(environment, "Ein Fragment ist nicht erlaubt.");
  }

  return url.origin;
};

const parseDeploymentRoute = (pattern, environment) => {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(pattern)
    ? pattern
    : `https://${pattern}`;
  try {
    return new URL(candidate);
  } catch (error) {
    throw invalidRouteError(environment, "Die Route konnte nicht als URL gelesen werden.", error);
  }
};

const parseResolvedOrigin = (origin, environment) => {
  try {
    return new URL(origin);
  } catch (error) {
    throw invalidRouteError(environment, "Die aufgelöste Route konnte nicht als URL gelesen werden.", error);
  }
};

export const resolveDeploymentOriginFromConfig = (config, environment) => {
  const pattern = config.env?.[environment]?.routes?.[0]?.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error(`Keine Route für ${environment} in wrangler.jsonc gefunden.`);
  }

  return validateDeploymentUrl(parseDeploymentRoute(pattern, environment), environment);
};

export const resolveDeploymentOrigin = async (
  environment,
  configPath = path.join(projectRoot, "wrangler.jsonc"),
) => {
  const resolvedConfigPath = path.resolve(configPath);
  let rawConfig;
  try {
    const { experimental_readRawConfig } = await import("wrangler");
    ({ rawConfig } = experimental_readRawConfig({ config: resolvedConfigPath }));
  } catch (error) {
    const configLabel = path.relative(projectRoot, resolvedConfigPath) || resolvedConfigPath;
    const reason = error instanceof Error ? error.message : "unbekannter Fehler";
    throw new Error(
      `Konfiguration ${configLabel} konnte nicht gelesen/geparst werden: ${reason}`,
      { cause: error },
    );
  }

  return resolveDeploymentOriginFromConfig(rawConfig, environment);
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const errorMessage = (error) => error instanceof Error ? error.message : String(error);

const fetchHealth = async (origin, environment, fetchImplementation, waitImplementation) => {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImplementation(`${origin}/healthz`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const body = await response.text();

      if (response.status !== 200) {
        throw new Error(`/healthz für ${environment} antwortete mit HTTP ${response.status}: ${body}`);
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        throw new Error(
          `/healthz für ${environment} lieferte kein JSON: ${errorMessage(error)}`,
          { cause: error },
        );
      }

      if (
        payload.status !== "ok" ||
        !Array.isArray(payload.missingBindings) ||
        payload.missingBindings.length !== 0
      ) {
        throw new Error(`/healthz meldet fehlende Bindings: ${JSON.stringify(payload)}`);
      }

      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await waitImplementation(retryDelayMs);
    }
  }

  throw new Error(
    `Healthcheck nach ${maxAttempts} Versuchen fehlgeschlagen: ${errorMessage(lastError)}`,
    { cause: lastError },
  );
};

export const checkHealth = async (
  environment,
  configPath,
  originOverride,
  {
    fetchImplementation = fetch,
    waitImplementation = wait,
  } = {},
) => {
  const resolvedOrigin = originOverride ?? await resolveDeploymentOrigin(environment, configPath);
  const origin = validateDeploymentUrl(parseResolvedOrigin(resolvedOrigin, environment), environment);
  await fetchHealth(origin, environment, fetchImplementation, waitImplementation);
  console.log(`/healthz ${environment}: ok (${origin})`);
};

const main = async () => {
  const command = process.argv[2];
  if (command === "--print-origin") {
    const environment = process.argv[3];
    if (environment === undefined) {
      console.error("Aufruf: check-health.mjs --print-origin <staging|production>");
      process.exitCode = 2;
      return;
    }
    console.log(await resolveDeploymentOrigin(environment, process.argv[4]));
    return;
  }

  if (command === "--origin") {
    const origin = process.argv[3];
    if (origin === undefined) {
      console.error("Aufruf: check-health.mjs --origin <origin>");
      process.exitCode = 2;
      return;
    }
    await checkHealth("direkte Origin", undefined, origin);
    return;
  }

  const environment = command;
  if (environment === undefined) {
    console.error("Aufruf: check-health.mjs <staging|production>");
    process.exitCode = 2;
    return;
  }

  await checkHealth(environment, process.argv[3]);
};

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
