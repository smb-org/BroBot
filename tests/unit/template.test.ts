import { describe, expect, it, vi } from "vitest";

import {
  closestTemplateVariable,
  invalidTemplateParameters,
  parseTemplateRange,
  renderTemplate,
  templateVariableNames,
  tokenizeTemplate,
  unknownTemplateVariables,
  worstCaseTemplateLength,
  type TemplateVariable,
} from "../../src/template";

const variables: readonly TemplateVariable[] = [
  { name: "user", group: "context", sample: "viewer", maxLength: 25, source: "system" },
  { name: "viewers", group: "stream", sample: "42", maxLength: 7, source: "system" },
  { name: "var.points", group: "channel", sample: "10", maxLength: 10, source: "channel" },
  { name: "random", group: "time_random", sample: "73", maxLength: 7, parameters: "range", source: "system" },
  { name: "pick", group: "time_random", sample: "heads", maxLength: 20, parameters: "choices", source: "system" },
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

  it("tokenizes variable sources and unknown tokens with source offsets", () => {
    expect(tokenizeTemplate("Hi {user}, {var.points}, {User}!", variables)).toEqual([
      { kind: "text", text: "Hi ", start: 0 },
      { kind: "system", text: "{user}", start: 3, name: "user" },
      { kind: "text", text: ", ", start: 9 },
      { kind: "channel", text: "{var.points}", start: 11, name: "var.points" },
      { kind: "text", text: ", ", start: 23 },
      { kind: "unknown", text: "{User}", start: 25, name: "User" },
      { kind: "text", text: "!", start: 31 },
    ]);
  });

  it("renders declared values and leaves unknown tokens literal", () => {
    expect(renderTemplate("Hi {user}, {zzz} and {User}", { user: "alice" }))
      .toBe("Hi alice, {zzz} and {User}");
  });

  it("validates parameterized variables and keeps invalid or unsupported tokens literal", () => {
    const random = vi.fn((maximumExclusive: number) => maximumExclusive - 1);
    const template = "{random 2-5}|{pick red|blue}|{random nope}|{user nope}|grinst";
    expect(invalidTemplateParameters(template, variables)).toEqual(["{random nope}"]);
    expect(renderTemplate(template, { user: "alice" }, {
      random: (parameter) => {
        const range = parseTemplateRange(parameter);
        return range === null ? "?" : String(range.min + random(range.max - range.min + 1));
      },
      pick: (parameter) => parameter.split("|").at(-1)?.trim() ?? "",
    }, variables)).toBe("5|blue|{random nope}|{user nope}|grinst");
  });

  it("counts maximum substitutions and an absent-variable fallback", () => {
    const duration: readonly TemplateVariable[] = [
      { name: "duration", group: "event", sample: "90", maxLength: 4, fallbackWhenAbsent: 15 },
    ];
    expect(worstCaseTemplateLength("Pause", duration)).toBe(20);
    expect(worstCaseTemplateLength("Pause {duration}", duration)).toBe("Pause ".length + 4);
  });
});
