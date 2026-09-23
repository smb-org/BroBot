import { describe, expect, it } from "vitest";

import {
  closestTemplateVariable,
  renderTemplate,
  templateVariableNames,
  tokenizeTemplate,
  unknownTemplateVariables,
  worstCaseTemplateLength,
  type TemplateVariable,
} from "../../src/template";

const variables: readonly TemplateVariable[] = [
  { name: "user", sample: "viewer", maxLength: 25 },
  { name: "viewers", sample: "42", maxLength: 7 },
];

describe("template helpers", () => {
  it("finds strict variable names and reports near-miss candidates", () => {
    expect(templateVariableNames("{user} {viewers} {User} {1}")).toEqual(["user", "viewers"]);
    expect(unknownTemplateVariables("{user} {zzz} {User} {User}", variables)).toEqual(["zzz", "User"]);
    expect(closestTemplateVariable("User", variables)).toBe("user");
  });

  it("only suggests close names", () => {
    expect(closestTemplateVariable("viewr", variables)).toBe("viewers");
    expect(closestTemplateVariable("zzzzzz", variables)).toBeNull();
    expect(closestTemplateVariable("viewer_count", variables)).toBeNull();
  });

  it("tokenizes known and unknown tokens with source offsets", () => {
    expect(tokenizeTemplate("Hi {user}, {User}!", variables)).toEqual([
      { kind: "text", text: "Hi ", start: 0 },
      { kind: "known", text: "{user}", start: 3 },
      { kind: "text", text: ", ", start: 9 },
      { kind: "unknown", text: "{User}", start: 11 },
      { kind: "text", text: "!", start: 17 },
    ]);
  });

  it("renders declared values and leaves unknown tokens literal", () => {
    expect(renderTemplate("Hi {user}, {zzz} and {User}", { user: "alice" }))
      .toBe("Hi alice, {zzz} and {User}");
  });

  it("counts maximum substitutions and an absent-variable fallback", () => {
    const duration: readonly TemplateVariable[] = [
      { name: "duration", sample: "90", maxLength: 4, fallbackWhenAbsent: 15 },
    ];
    expect(worstCaseTemplateLength("Pause", duration)).toBe(20);
    expect(worstCaseTemplateLength("Pause {duration}", duration)).toBe("Pause ".length + 4);
  });
});
