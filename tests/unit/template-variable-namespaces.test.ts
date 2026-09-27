import { describe, expect, it } from "vitest";

import { adsModule } from "../../src/modules/ads";
import { textLibraryModule } from "../../src/modules/text_library";
import { validateModuleTemplateVariable } from "../../src/modules/registry";

describe("module template variable namespaces", () => {
  it("requires dotted names for non-block module variables", () => {
    expect(() => { validateModuleTemplateVariable(adsModule, "weather.temp"); }).not.toThrow();
    expect(() => { validateModuleTemplateVariable(adsModule, "weather"); }).toThrow(/dotted name/u);
  });

  it("allows bare text block names while keeping existing host variables reserved", () => {
    expect(() => { validateModuleTemplateVariable(textLibraryModule, "welcome"); }).not.toThrow();
    expect(() => { validateModuleTemplateVariable(textLibraryModule, "args"); }).toThrow(/reserved by the host/u);
  });
});
