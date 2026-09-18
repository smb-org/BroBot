import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { experimental_readRawConfig } from "wrangler";

const projectRoot = path.resolve(import.meta.dirname, "..");
const httpStatusMarker = "\n__BROBOT_HTTP_STATUS__";

const resolveDeploymentOriginFromConfig = (config, environment) => {
  const pattern = config.env?.[environment]?.routes?.[0]?.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error(`Keine Route für ${environment} in wrangler.jsonc gefunden.`);
  }

  return /^https?:\/\//.test(pattern)
    ? new URL(pattern).origin
    : `https://${pattern.replace(/\/.*$/, "")}`;
};

export const resolveDeploymentOrigin = async (
  environment,
  configPath = path.join(projectRoot, "wrangler.jsonc"),
) => {
  const resolvedConfigPath = path.resolve(configPath);
  let rawConfig;
  try {
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

const checkHealth = async (environment) => {
  const origin = await resolveDeploymentOrigin(environment);
  const result = spawnSync("curl", [
    "--silent",
    "--show-error",
    "--location",
    "--max-time",
    "30",
    "--retry",
    "5",
    "--retry-delay",
    "2",
    "--retry-all-errors",
    "--write-out",
    `${httpStatusMarker}%{http_code}`,
    `${origin}/healthz`,
  ], { encoding: "utf8" });

  if (result.error !== undefined) throw result.error;

  const output = result.stdout ?? "";
  const markerIndex = output.lastIndexOf(httpStatusMarker);
  if (markerIndex === -1) {
    throw new Error(`curl lieferte keinen HTTP-Status für ${origin}/healthz.`);
  }

  const body = output.slice(0, markerIndex);
  const status = output.slice(markerIndex + httpStatusMarker.length).trim();
  if (result.status !== 0) {
    throw new Error(
      `curl für ${origin}/healthz schlug fehl (Exit ${result.status}): ` +
      (result.stderr ?? "").trim(),
    );
  }
  if (status !== "200") {
    throw new Error(`/healthz für ${environment} antwortete mit HTTP ${status}: ${body}`);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `/healthz für ${environment} lieferte kein JSON: ` +
      (error instanceof Error ? error.message : "unbekannter Fehler"),
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

  const environment = command;
  if (environment === undefined) {
    console.error("Aufruf: check-health.mjs <staging|production>");
    process.exitCode = 2;
    return;
  }

  await checkHealth(environment);
};

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
