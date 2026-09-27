import { describe, expect, it } from "vitest";

import { adsModule } from "../../src/modules/ads";
import { raidModule } from "../../src/modules/raid";
import { textLibraryModule } from "../../src/modules/text_library";
import { validateModuleTemplateVariable, variablesForModuleTemplateContext } from "../../src/modules/registry";
import { templateVariableNames } from "../../src/template";

describe("module template variable namespaces", () => {
  it("requires dotted names for non-block module variables", () => {
    expect(() => { validateModuleTemplateVariable(adsModule, "weather.temp"); }).not.toThrow();
    expect(() => { validateModuleTemplateVariable(adsModule, "weather"); }).toThrow(/dotted name/u);
  });

  it("allows bare text block names while keeping existing host variables reserved", () => {
    expect(() => { validateModuleTemplateVariable(textLibraryModule, "welcome"); }).not.toThrow();
    expect(() => { validateModuleTemplateVariable(textLibraryModule, "args"); }).toThrow(/reserved by the host/u);
  });

  it.each(["1hello", "_hello"]) ("accepts and parses valid block name %s", (name) => {
    expect(() => { validateModuleTemplateVariable(textLibraryModule, name); }).not.toThrow();
    expect(templateVariableNames(`{${name}}`)).toEqual([name]);
  });

  it("accepts only dotted module names the template parser can read", () => {
    expect(() => { validateModuleTemplateVariable(adsModule, "weather.current.temperature"); }).not.toThrow();
    expect(templateVariableNames("{weather.current.temperature}")).toEqual(["weather.current.temperature"]);
  });

  it("tags raid variables with their event context for scoped previews", () => {
    const variables = Object.values(raidModule.templateFields ?? {}).flat();
    expect(variablesForModuleTemplateContext(raidModule, variables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "channel", contexts: ["event"] }),
      expect.objectContaining({ name: "viewers", contexts: ["event"] }),
    ]));
  });
});
