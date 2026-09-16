import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const projectRoot = path.resolve(import.meta.dirname, "..");
const deploymentBindings = [
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_SECRET",
  "PUBLIC_ORIGIN",
  "SESSION_COOKIE_KEYS",
  "SESSION_ENCRYPTION_KEYS",
  "OVERLAY_TOKEN_PEPPER",
];
const deploymentBindingSet = new Set(deploymentBindings);
const placeholderPattern = /replace-with|example\.invalid/i;
const environmentNames = ["staging", "production"];
const expectedWorkerNames = {
  local: "brobot-local",
  staging: "brobot-staging",
  production: "brobot",
};

const readSourceConfig = async () => {
  const source = await readFile(path.join(projectRoot, "wrangler.jsonc"), "utf8");
  // Bewusst nur ganzzeilige `//`-Kommentare: ein Kommentar hinter einem Wert
  // überlebt das Strippen nicht und lässt JSON.parse scheitern. Deshalb
  // stehen Kommentare in wrangler.jsonc immer auf eigener Zeile. Wird das zu
  // eng, kommt ein echter JSONC-Parser statt dieser Zeile.
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
};

const requiredSecretsFor = (config, environment) => {
  const required = environment === "local"
    ? config.secrets?.required
    : config.env?.[environment]?.secrets?.required;
  return Array.isArray(required) ? required : deploymentBindings;
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
    .filter((name) => deploymentBindingSet.has(name));
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
    const missing = required.filter((name) => values[name] === undefined);
    if (missing.length > 0) failures.push(`${fileName}: Beispielwerte fehlen: ${missing.join(", ")}`);
  } catch (error) {
    failures.push(
      `${fileName}: ${error instanceof Error ? error.message : "konnte nicht gelesen werden"}`,
    );
  }
};

const validateDeploymentValues = (environment, values, required) => {
  const failures = [];
  const missing = required.filter((name) => (values[name] ?? "").trim() === "");
  if (missing.length > 0) failures.push(`Werte fehlen: ${missing.join(", ")}`);

  const placeholders = required.filter((name) => {
    const value = values[name];
    return value !== undefined && placeholderPattern.test(value);
  });
  if (placeholders.length > 0) {
    failures.push(`Platzhalterwerte sind nicht erlaubt: ${placeholders.join(", ")}`);
  }

  const unexpected = Object.keys(values).filter((name) => !deploymentBindingSet.has(name));
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
