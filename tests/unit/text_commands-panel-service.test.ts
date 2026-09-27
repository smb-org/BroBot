import { describe, expect, it } from "vitest";

import { textBlockNamesForPicker } from "../../src/modules/text_commands/panel/service";
import type { ModuleRegisteredTemplateVariable } from "../../src/modules/contract";

const registration = (moduleId: string, name: string, isTextBlock: boolean): ModuleRegisteredTemplateVariable => ({
  moduleId,
  name,
  isTextBlock,
  sample: "sample",
  maxLength: 25,
});

describe("text command text-block picker", () => {
  it("does not mistake bare raid variables for text blocks when the library is empty", () => {
    expect(textBlockNamesForPicker([
      registration("raid", "channel", false),
      registration("raid", "viewers", false),
    ])).toEqual([]);
  });

  it("offers only registrations marked as text blocks", () => {
    expect(textBlockNamesForPicker([
      registration("raid", "channel", false),
      registration("text_library", "1hello", true),
    ])).toEqual(["1hello"]);
  });
});
