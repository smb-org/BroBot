import { ESLint } from "eslint";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The raw-field guard (editor-konzept 15.5, eslint.config.js) is a JSX
 * `no-restricted-syntax` selector, not an import restriction -- it depends
 * on a file's actual content, so `calculateConfigForFile` (used by
 * `eslint-config.test.ts` for the import boundaries) can't exercise it.
 * These probes write real, throwaway files under repo paths that match the
 * rule's `files`/`ignores` globs and lint them for real.
 */
const eslint = new ESLint({ cwd: process.cwd() });

const rawFieldMessage = "Raw form fields only in src/dashboard/ui/";

const probeUnderTest: string[] = [];

const lintProbe = async (relativePath: string, code: string): Promise<boolean> => {
  const filePath = path.resolve(process.cwd(), relativePath);
  probeUnderTest.push(filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, code, "utf8");
  const [result] = await eslint.lintFiles([filePath]);
  return (result?.messages ?? []).some(
    (message) => message.ruleId === "no-restricted-syntax" && message.message.includes(rawFieldMessage),
  );
};

afterEach(async () => {
  await Promise.all(probeUnderTest.splice(0).map((filePath) => rm(filePath, { force: true })));
});

describe("raw-field ESLint guard (editor-konzept 15.5)", () => {
  it("flags a raw <input> under src/dashboard/, outside the seam", async () => {
    expect(await lintProbe("src/dashboard/__eslint_probe_input__.tsx", "export const Probe = () => <input />;\n")).toBe(true);
  }, 20_000);

  it("flags <select> and <textarea> the same way", async () => {
    expect(await lintProbe("src/dashboard/__eslint_probe_select__.tsx", "export const Probe = () => <select></select>;\n")).toBe(true);
    expect(await lintProbe("src/dashboard/__eslint_probe_textarea__.tsx", "export const Probe = () => <textarea></textarea>;\n")).toBe(true);
  }, 20_000);

  it("exempts src/dashboard/ui/ -- the seam is where raw fields live", async () => {
    expect(await lintProbe("src/dashboard/ui/__eslint_probe_input__.tsx", "export const Probe = () => <input />;\n")).toBe(false);
  }, 20_000);

  it("does not flag a seam component or a string that merely looks like a tag", async () => {
    expect(await lintProbe(
      "src/dashboard/__eslint_probe_field__.tsx",
      'import { Field } from "./ui";\nexport const Probe = () => <Field label="x" hint="y" value="" onChange={() => {}} />;\n',
    )).toBe(false);
    expect(await lintProbe("src/dashboard/__eslint_probe_string__.tsx", 'export const probe = "<input";\n')).toBe(false);
  }, 20_000);

  it("covers the module panels too", async () => {
    expect(await lintProbe("src/modules/raid/panel/__eslint_probe_input__.tsx", "export const Probe = () => <input />;\n")).toBe(true);
  }, 20_000);
});
