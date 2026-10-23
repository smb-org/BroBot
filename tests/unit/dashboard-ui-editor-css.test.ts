import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(path.resolve(process.cwd(), "src/dashboard/ui/core.css"), "utf8");
const dashboardSource = readFileSync(path.resolve(process.cwd(), "src/dashboard/main.tsx"), "utf8");
const switchStyles = readFileSync(path.resolve(process.cwd(), "src/dashboard/ui/primitives/switch.tsx"), "utf8");
const timerStyles = readFileSync(path.resolve(process.cwd(), "src/modules/timers/panel/panel.css"), "utf8");
const textCommandStyles = readFileSync(path.resolve(process.cwd(), "src/modules/text_commands/panel/panel.css"), "utf8");
const textCommandSource = readFileSync(path.resolve(process.cwd(), "src/modules/text_commands/panel/index.tsx"), "utf8");
const cockpitStyles = readFileSync(path.resolve(process.cwd(), "src/dashboard/cockpit.css"), "utf8");
const cockpitPartsSource = readFileSync(path.resolve(process.cwd(), "src/dashboard/LiveCockpitParts.tsx"), "utf8");

describe("editor seam styles", () => {
  it("uses the editor container threshold for FieldPair without viewport JavaScript", () => {
    expect(styles).toMatch(/@container editor \(min-width: 380px\)\s*\{\s*\.ui-field-pair\s*\{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/u);
    expect(styles).toMatch(/\.ui-field-pair \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\);/u);
  });

  it("keeps template text field geometry and token decoration metrics aligned", () => {
    const geometry = styles.match(/\.template-text-field \.template-text-field__input\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(geometry).toContain("font-size: 14px;");
    expect(geometry).toContain("line-height: 1.5;");
    expect(geometry).toContain("padding: var(--s3) var(--s3) var(--s2);");
    expect(styles).not.toContain("template-text-field__mirror");
    expect(styles).not.toContain("data-highlight-ready");
    const module = styles.match(/\.template-text-field__decoration--module\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(module).toContain("color: var(--brand-text);");
    expect(module).toContain("background: var(--tint-1);");
    expect(module).not.toMatch(/padding|border|letter-spacing|font(?:-family|-size|-weight)?\s*:/u);
    const unknown = styles.match(/\.template-text-field__decoration--unknown\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(unknown).toContain("text-decoration: underline wavy var(--warn);");
    expect(unknown).not.toMatch(/padding|border|letter-spacing|font(?:-family|-size|-weight)?\s*:/u);
  });

  it("keeps unit inputs and confirmation actions readable at narrow widths", () => {
    expect(styles).toContain(".unit-input__control { position: relative; min-width: 0; }");
    expect(styles).toContain(".unit-input__input { padding-right: 4rem; font-family: \"IBM Plex Mono\", ui-monospace, monospace; }");
    expect(styles).toContain(".unit-input__unit { position: absolute; top: 0; right: 10px;");
    expect(styles).toContain(".ui-field__input--with-leading:not(.ui-field__input--with-prefix) { padding-left: 34px; }");
    expect(styles).toContain(".ui-field__leading--prefix { position: static; display: flex; flex: 0 0 auto; width: auto; height: var(--control-height); padding: 0 8px; border-right: 1px solid var(--line); }");
    expect(styles).toContain(".ui-field__input--with-prefix { flex: 1 1 0%; width: auto; min-width: 0; padding-left: 0; }");
    expect(styles).toContain(".ui-confirm-dialog__actions { display: flex; flex-wrap: wrap;");
    expect(styles).toContain("@media (max-width: 600px)");
    expect(styles).toContain(".ui-confirm-dialog__actions { flex-direction: column; align-items: stretch; }");
    expect(styles).toContain(".ui-editor-shell { display: flex; height: max-content; flex-direction: column;");
    expect(styles).toContain("overflow: hidden;");
    expect(styles).toContain(".ui-editor-shell__body { flex: 1 1 auto; min-height: 0; overflow: auto;");
    expect(styles).toContain(".ui-save-bar { box-sizing: border-box; display: grid; grid-template-columns: minmax(0, 1fr) auto;");
    expect(styles).toContain(".ui-save-bar__invalid-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
  });

  it("aligns the SwitchRow control to the right column and distinguishes checked, invalid, and disabled states", () => {
    expect(styles).toContain(".ui-switch-row [data-slot=\"switch\"] { grid-column: 2; grid-row: 1; }");
    const row = styles.match(/\.ui-switch-row\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(row).toContain("padding-inline-end: 8px;");
    expect(switchStyles).toContain("data-checked:bg-[var(--color-brand)]");
    expect(switchStyles).toContain("data-checked:bg-[var(--color-brand-on)]");
    expect(switchStyles).toContain("data-disabled:opacity-70");
    expect(switchStyles).toContain("aria-invalid:border-[var(--color-error)]");
    expect(switchStyles).toContain("focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]");
  });

  it("keeps both mobile interval states separated from their headings", () => {
    const expandedContent = styles.match(/\.ui-switch-section__content\s*\{([^}]+)\}/u)?.[1] ?? "";
    const collapsedHint = styles.match(/\.ui-switch-section__hint\s*\{([^}]+)\}/u)?.[1] ?? "";

    expect(expandedContent).toContain("padding: 12px 0 0;");
    expect(expandedContent).toContain("border-top: 1px solid var(--color-border);");
    expect(collapsedHint).toContain("padding: 12px 0 0;");
    expect(collapsedHint).toContain("border-top: 1px solid var(--color-border);");
  });

  it("pushes weekday switches to the right edge of their timer rows", () => {
    const weekday = timerStyles.match(/\.timer-weekday\s*\{([^}]+)\}/u)?.[1] ?? "";

    expect(weekday).toContain("justify-content: space-between;");
  });

  it("pushes the read-only text command switch to the right edge of its value cell", () => {
    const control = textCommandStyles.match(/\.text-command-properties__switch\s*\{([^}]+)\}/u)?.[1] ?? "";

    expect(control).toContain("justify-content: flex-end;");
  });

  it("uses one shared fixed save bar treatment for mobile editor headers", () => {
    expect(styles).toMatch(/\.page-header__save:has\(> \.ui-save-bar--mobile-fixed\)\s*\{[^}]*position: fixed;/u);
    expect(styles).toMatch(/\.page-header__save:has\(> \.ui-save-bar--mobile-fixed\) > \.ui-save-bar--mobile-fixed \{[^}]*min-height: 44px;[^}]*padding: 0;/u);
    expect(textCommandSource).toContain("saveStatus={saveBar}");
    expect(textCommandStyles).not.toMatch(/\.text-command-editor \.page-header__save[^{}]*\{[^{}]*\}/u);
  });

  it("collapses unused dashboard header status slots while preserving labeled slots", () => {
    expect(dashboardSource).toContain('configured && label !== null ? "" : " is-empty"');
    expect(styles).toContain(".dashboard-header__control-state-slot { display: block; flex: none; width: max-content; max-width: 180px; min-width: 0; }");
    expect(styles).toContain(".dashboard-header__control-state-slot.is-empty { display: none; }");
  });

  it("lets populated control statuses size to their label while retaining narrow header cutoffs", () => {
    expect(styles).toContain(".dashboard-header__control-state-slot { display: block; flex: none; width: max-content; max-width: 180px; min-width: 0; }");
    expect(styles).toContain("@container dashboard-header-end (max-width: 740px) {");
    expect(styles).toContain(".dashboard-header__control-state-slot { display: none; }");
    expect(styles).toContain(".dashboard-header__status, .dashboard-header__controls { display: none; }");
    expect(styles).toContain(".dashboard-header__control-state > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
  });

  it("keeps the upcoming action reason in a reserved slot beside its action", () => {
    expect(cockpitPartsSource).toContain("live-cockpit-next-item__action");
    const action = cockpitStyles.match(/\.live-cockpit-next-item__action\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(action).toContain("display: contents;");
    expect(action).not.toContain("max-content");
    expect(cockpitStyles).not.toContain(":has(.live-cockpit-next-item__action)");
    const reason = cockpitStyles.match(/\.live-cockpit-next-item__reason\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(reason).toContain("grid-column: 2 / -1;");
    expect(reason).toContain("grid-row: 2;");
    expect(reason).toContain("height: 24px;");
    expect(reason).not.toContain("nowrap");
  });

  it("applies the shared hand-drawn SVG stroke family to command palette module icons", () => {
    expect(styles).toMatch(/\.module-glyph \{[^}]*fill: none; stroke: currentColor; stroke-width: 1\.5; stroke-linecap: round; stroke-linejoin: round;/u);
    expect(styles).toContain(".command-palette-module-icon { width: 20px; height: 20px; }");
  });

  it("reserves fixed command palette rows and moves narrow descriptions below their titles", () => {
    const desktopRow = styles.match(/\.command-palette__list \[cmdk-item\] \{([^}]+)\}/u)?.[1] ?? "";
    expect(desktopRow).toContain("height: 42px;");
    expect(desktopRow).toContain("min-height: 42px;");
    const mobileStart = styles.indexOf("@media (max-width: 639px)", styles.indexOf(".command-palette__list [cmdk-item]"));
    const mobileEnd = mobileStart < 0 ? -1 : styles.indexOf("\n}", mobileStart);
    const mobileStyles = mobileStart < 0 || mobileEnd < 0 ? "" : styles.slice(mobileStart, mobileEnd);
    expect(mobileStyles).toMatch(/\.command-palette__list \[cmdk-item\] \{[^}]*height: 58px;[^}]*min-height: 58px;/u);
    expect(mobileStyles).toMatch(/\.command-palette__item-copy \{[^}]*grid-row: 1;/u);
    expect(mobileStyles).toMatch(/\.command-palette__inline-reason \{[^}]*grid-row: 2;/u);
  });
});
