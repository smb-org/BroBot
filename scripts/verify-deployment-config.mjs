import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

import { readWranglerConfig } from "./read-wrangler-config.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const deploymentBindings = [
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_SECRET",
  "PUBLIC_ORIGIN",
  "SESSION_COOKIE_KEYS",
  "TOKEN_ENCRYPTION_KEYS",
  "OVERLAY_TOKEN_PEPPER",
  "PLATFORM_USER_IDS",
];
const compatibilitySecretAliases = {
  TOKEN_ENCRYPTION_KEYS: ["SESSION_ENCRYPTION_KEYS"],
  PLATFORM_USER_IDS: ["BETREIBER_USER_IDS"],
};
const acceptedSecretNameSet = new Set([
  ...deploymentBindings,
  ...Object.values(compatibilitySecretAliases).flat(),
]);
const keyRingSecretNames = new Set([
  "TWITCH_EVENTSUB_SECRET",
  "SESSION_COOKIE_KEYS",
  "TOKEN_ENCRYPTION_KEYS",
]);
const placeholderPattern = /replace-with|example\.invalid/i;
const environmentNames = ["staging", "production"];
const expectedWorkerNames = {
  local: "brobot-local",
  staging: "brobot-staging",
  production: "brobot",
};

const isAbsoluteOrigin = (value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

const readSourceConfig = async () => {
  return readWranglerConfig(path.join(projectRoot, "wrangler.jsonc"));
};

const requiredSecretsFor = (config, environment) => {
  const required = environment === "local"
    ? config.secrets?.required
    : config.env?.[environment]?.secrets?.required;
  return Array.isArray(required) ? required : deploymentBindings;
};

// Die erforderlichen Secret-Namen existieren dreifach: hier als
// `deploymentBindings`, in wrangler.jsonc unter `secrets.required` (je
// Umgebung) und in src/worker/config.ts als `REQUIRED_SECRET_NAMES`. Läuft
// eine Liste bei einer Ergänzung aus dem Gleichschritt, meldet /healthz
// trotzdem 200, obwohl ein Secret fehlt — genau der Fehler, den der
// Health-Check eigentlich anzeigen soll. Diese Prüfung hält alle drei
// synchron, ohne sie zusammenzuführen (der Worker kann wrangler.jsonc zur
// Laufzeit nicht lesen).
const extractWorkerRequiredSecretNames = (workerSource) => {
  const arrayMatch = workerSource.match(/REQUIRED_SECRET_NAMES\s*=\s*\[([\s\S]*?)\]/);
  if (arrayMatch === null) return null;
  const names = [...arrayMatch[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  return names.length > 0 ? names : null;
};

const rawRequiredSecretsFor = (config, environment) => {
  const required = environment === "local"
    ? config.secrets?.required
    : config.env?.[environment]?.secrets?.required;
  return Array.isArray(required) ? required : null;
};

const secretNamesFor = (name) => [name, ...(compatibilitySecretAliases[name] ?? [])];

const configuredSecretValue = (values, name) => {
  for (const candidate of secretNamesFor(name)) {
    if (typeof values[candidate] === "string" && values[candidate].trim() !== "") {
      return values[candidate];
    }
  }
  return undefined;
};

export const checkSecretListDrift = async (config, failures) => {
  let workerSource;
  try {
    workerSource = await readFile(path.join(projectRoot, "src/worker/config.ts"), "utf8");
  } catch (error) {
    failures.push(
      `src/worker/config.ts konnte nicht gelesen werden: ` +
      (error instanceof Error ? error.message : "unbekannter Fehler"),
    );
    return;
  }

  const workerNames = extractWorkerRequiredSecretNames(workerSource);
  if (workerNames === null) {
    failures.push(
      "REQUIRED_SECRET_NAMES konnte nicht aus src/worker/config.ts extrahiert werden " +
      "(Array-Block nicht gefunden). Drift-Prüfung der Secret-Namen kann nicht laufen.",
    );
    return;
  }
  const workerSet = new Set(workerNames);

  const diffAgainstWorker = (label, otherNames) => {
    const otherSet = new Set(otherNames);
    const missing = workerNames.filter((name) => !otherSet.has(name));
    const extra = otherNames.filter((name) => !workerSet.has(name));
    if (missing.length > 0) {
      failures.push(`${label}: fehlt gegenüber REQUIRED_SECRET_NAMES: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      failures.push(`${label}: zusätzlich gegenüber REQUIRED_SECRET_NAMES: ${extra.join(", ")}`);
    }
  };

  diffAgainstWorker("scripts/verify-deployment-config.mjs (deploymentBindings)", deploymentBindings);

  for (const environment of ["local", ...environmentNames]) {
    const raw = rawRequiredSecretsFor(config, environment);
    if (raw === null) {
      failures.push(
        `wrangler.jsonc secrets.required (${environment}) fehlt oder ist kein Array.`,
      );
      continue;
    }
    diffAgainstWorker(`wrangler.jsonc secrets.required (${environment})`, raw);
  }
};

const checkEnvironmentShape = (config, environment, failures) => {
  const section = environment === "local" ? config : config.env?.[environment];
  if (section === undefined) {
    failures.push(`Wrangler-Umgebung fehlt: ${environment}`);
    return;
  }

  const expectedName = expectedWorkerNames[environment];
  if (section.name !== expectedName) {
    failures.push(`Worker-Name für ${environment} muss ${expectedName} sein.`);
  }
  if (section.vars?.APP_ENV !== environment) {
    failures.push(`APP_ENV für ${environment} muss ${environment} sein.`);
  }

  const leakedBindings = Object.keys(section.vars ?? {})
    .filter((name) => acceptedSecretNameSet.has(name));
  if (leakedBindings.length > 0) {
    failures.push(
      `${environment}: Secrets sind als Klartext-vars gebaut: ${leakedBindings.join(", ")}`,
    );
  }

  const required = new Set(requiredSecretsFor(config, environment));
  const missingRequired = deploymentBindings.filter((name) => !required.has(name));
  if (missingRequired.length > 0) {
    failures.push(`${environment}: Erforderliche Secrets fehlen: ${missingRequired.join(", ")}`);
  }
};

const checkExampleFile = async (fileName, required, failures) => {
  try {
    const values = parseEnv(await readFile(path.join(projectRoot, fileName), "utf8"));
    const missing = required.filter((name) => configuredSecretValue(values, name) === undefined);
    if (missing.length > 0) failures.push(`${fileName}: Beispielwerte fehlen: ${missing.join(", ")}`);
    for (const name of keyRingSecretNames) {
      const value = configuredSecretValue(values, name);
      if (value !== undefined && !isKeyRingShape(value)) {
        failures.push(`${fileName}: ${name} hat nicht das active/retired-Format.`);
      }
    }
    const pepper = values.OVERLAY_TOKEN_PEPPER;
    if (pepper !== undefined && !placeholderPattern.test(pepper) && !isBase64url32Byte(pepper)) {
      failures.push(`${fileName}: OVERLAY_TOKEN_PEPPER hat nicht das 32-Byte-base64url-Format.`);
    }
  } catch (error) {
    failures.push(
      `${fileName}: ${error instanceof Error ? error.message : "konnte nicht gelesen werden"}`,
    );
  }
};

const isBase64url32Byte = (value) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(44, "=");
    return Buffer.from(normalized, "base64").byteLength === 32;
  } catch {
    return false;
  }
};

const isKeyRingShape = (value) => {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    if (parsed.active === null || typeof parsed.active !== "object" || Array.isArray(parsed.active)) return false;
    if (typeof parsed.active.id !== "string" || parsed.active.id.length === 0) return false;
    if (typeof parsed.active.key !== "string" || parsed.active.key.length === 0) return false;
    if (parsed.retired !== undefined && !Array.isArray(parsed.retired)) return false;
    const retired = parsed.retired ?? [];
    if (retired.some((entry) =>
      entry === null || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.id !== "string" || entry.id.length === 0 ||
      typeof entry.key !== "string" || entry.key.length === 0)) return false;
    const ids = [parsed.active.id, ...retired.map((entry) => entry.id)];
    if (new Set(ids).size !== ids.length) return false;

    const isPlaceholder = (key) => placeholderPattern.test(key);
    const keys = [parsed.active.key, ...retired.map((entry) => entry.key)];
    return keys.every((key) => isPlaceholder(key) || isBase64url32Byte(key));
  } catch {
    return false;
  }
};

const validateDeploymentValues = (environment, values, required) => {
  const failures = [];
  const missing = required.filter((name) => configuredSecretValue(values, name) === undefined);
  if (missing.length > 0) failures.push(`Werte fehlen: ${missing.join(", ")}`);

  const placeholders = required.flatMap((name) => secretNamesFor(name)).filter((name) => {
    const value = values[name];
    return value !== undefined && placeholderPattern.test(value);
  });
  if (placeholders.length > 0) {
    failures.push(`Platzhalterwerte sind nicht erlaubt: ${placeholders.join(", ")}`);
  }

  const origin = values.PUBLIC_ORIGIN;
  if (origin !== undefined && !placeholderPattern.test(origin) && !isAbsoluteOrigin(origin)) {
    failures.push("Ungültige absolute Origin: PUBLIC_ORIGIN");
  }

  const malformedKeyRings = [...keyRingSecretNames].filter((name) => {
    const value = configuredSecretValue(values, name);
    return value !== undefined && !isKeyRingShape(value);
  });
  if (malformedKeyRings.length > 0) {
    failures.push(`Ungültiges active/retired-Format: ${malformedKeyRings.join(", ")}`);
  }

  const pepper = values.OVERLAY_TOKEN_PEPPER;
  if (pepper !== undefined && !placeholderPattern.test(pepper) && !isBase64url32Byte(pepper)) {
    failures.push("Ungültiges 32-Byte-base64url-Format: OVERLAY_TOKEN_PEPPER");
  }

  const unexpected = Object.keys(values).filter((name) => !acceptedSecretNameSet.has(name));
  if (unexpected.length > 0) failures.push(`Unerwartete Werte: ${unexpected.join(", ")}`);

  if (failures.length > 0) {
    console.error(
      `Deploymentwerte für ${environment} sind ungültig:\n` +
      failures.map((failure) => `- ${failure}`).join("\n"),
    );
    return false;
  }
  console.log(`Verified private ${environment} deployment values.`);
  return true;
};

const validateEnvironmentFile = async (environment, relativeFile) => {
  const config = await readSourceConfig();
  const section = config.env?.[environment];
  if (section === undefined) {
    console.error(`Wrangler-Umgebung fehlt: ${environment}`);
    return false;
  }

  try {
    const values = parseEnv(await readFile(path.resolve(projectRoot, relativeFile), "utf8"));
    return validateDeploymentValues(environment, values, requiredSecretsFor(config, environment));
  } catch (error) {
    console.error(
      `Deploymentdatei für ${environment} konnte nicht gelesen werden: ` +
      (error instanceof Error ? error.message : "unbekannter Fehler"),
    );
    return false;
  }
};

const validateSourceConfig = async () => {
  const failures = [];
  const config = await readSourceConfig();

  await checkSecretListDrift(config, failures);
  checkEnvironmentShape(config, "local", failures);
  for (const environment of environmentNames) checkEnvironmentShape(config, environment, failures);

  await checkExampleFile(".dev.vars.example", requiredSecretsFor(config, "local"), failures);
  for (const environment of environmentNames) {
    await checkExampleFile(
      `.env.${environment}.example`,
      requiredSecretsFor(config, environment),
      failures,
    );

    const privateName = `.env.${environment}`;
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", privateName], {
      cwd: projectRoot,
    });
    if (ignored.status !== 0) failures.push(`${privateName} wird nicht durch .gitignore geschützt.`);

    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", privateName], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    if (tracked.status === 0) failures.push(`${privateName} darf nicht von Git verfolgt werden.`);
  }

  if (failures.length > 0) {
    console.error(
      "Deployment-Konfiguration ist nicht sicher:\n" +
      failures.map((failure) => `- ${failure}`).join("\n"),
    );
    return false;
  }

  console.log("Verified external staging and production deployment bindings.");
  return true;
};

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const command = process.argv[2];
  if (command === "validate-env") {
    const environment = process.argv[3];
    const relativeFile = process.argv[4];
    if (!environmentNames.includes(environment ?? "") || relativeFile === undefined) {
      console.error("Aufruf: verify-deployment-config.mjs validate-env <staging|production> <datei>");
      process.exitCode = 2;
    } else if (!await validateEnvironmentFile(environment, relativeFile)) {
      process.exitCode = 1;
    }
  } else if (command !== undefined) {
    console.error(`Unbekannter Prüfmodus: ${command}`);
    process.exitCode = 2;
  } else if (!await validateSourceConfig()) {
    process.exitCode = 1;
  }
}
