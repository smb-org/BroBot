import { describe, expect, it } from "vitest";

import { API_SOURCE_FUNCTION_CATALOG, type ApiSourceFunctionGroup } from "../../src/modules/api_source/contracts/function-catalog";
import { apiSourceFunctionAtCaret, expressionFunctionQueryAtCaret, expressionHasCallOpeningParenthesis, groupApiSourceFunctions } from "../../src/modules/api_source/panel/expression-field-model";

const groupLabels: Readonly<Record<ApiSourceFunctionGroup, string>> = {
  text: "Text",
  number: "Number",
  logic: "Logic",
  list: "Lists",
  date: "Date",
};

describe("ExpressionField model", () => {
  it("opens a query at the dollar token, avoids JSON root paths and quoted text, and replaces a full partial name", () => {
    expect(expressionFunctionQueryAtCaret("$.daily.sunset", 1)).toBeNull();
    expect(expressionFunctionQueryAtCaret("'price $from'", 11)).toBeNull();
    expect(expressionFunctionQueryAtCaret("$.daily $fromMillis", 17)).toEqual({ fragment: "fromMill", start: 8, end: 19 });
    expect(expressionFunctionQueryAtCaret("$", 1)).toEqual({ fragment: "", start: 0, end: 1 });
  });

  it("shows the innermost allowlisted call at the caret and ignores strings and completed calls", () => {
    expect(apiSourceFunctionAtCaret("$substring($.value, $trim(", 26, API_SOURCE_FUNCTION_CATALOG)?.name).toBe("trim");
    expect(apiSourceFunctionAtCaret("$substring($trim($.value),", 26, API_SOURCE_FUNCTION_CATALOG)?.name).toBe("substring");
    expect(apiSourceFunctionAtCaret("'$substring(", 12, API_SOURCE_FUNCTION_CATALOG)).toBeNull();
    expect(apiSourceFunctionAtCaret("$trim($.value)", 15, API_SOURCE_FUNCTION_CATALOG)).toBeNull();
  });

  it("ignores function-like text in comments when showing a call signature", () => {
    const expression = "$round(3.141, /* $trim( */ 2)";
    expect(apiSourceFunctionAtCaret(expression, expression.length - 1, API_SOURCE_FUNCTION_CATALOG)?.name).toBe("round");
    const commentedCall = "$round /* preserve this */ (3.141, /* $trim( */ 2)";
    expect(apiSourceFunctionAtCaret(commentedCall, commentedCall.length - 1, API_SOURCE_FUNCTION_CATALOG)?.name).toBe("round");
    expect(expressionHasCallOpeningParenthesis(commentedCall, "$round".length)).toBe(true);
  });

  it("does not open the function picker inside a comment", () => {
    expect(expressionFunctionQueryAtCaret("$round(3.141, /* $trim", 22)).toBeNull();
  });

  it("opens the function picker after a backtick field name containing an apostrophe", () => {
    const fieldName = "$.`owner's field` + $tri";
    expect(expressionFunctionQueryAtCaret(fieldName, fieldName.length)).toEqual({
      fragment: "tri",
      start: fieldName.lastIndexOf("$"),
      end: fieldName.length,
    });
    const commentText = "$trim('/*') + $tri";
    expect(expressionFunctionQueryAtCaret(commentText, commentText.length)).toEqual({
      fragment: "tri",
      start: commentText.lastIndexOf("$"),
      end: commentText.length,
    });
  });

  it("filters and groups functions without duplicate entries", () => {
    const groups = groupApiSourceFunctions(API_SOURCE_FUNCTION_CATALOG, "en", groupLabels, "from");
    const entries = groups.flatMap(({ options }) => options.map(({ option }) => option));
    expect(entries.map(({ name }) => name)).toEqual(["fromMillis", "trim"]);
    expect(groups.map(({ group }) => group.id)).toEqual(["date", "text"]);

    const all = groupApiSourceFunctions(API_SOURCE_FUNCTION_CATALOG, "en", groupLabels, "");
    const names = all.flatMap(({ options }) => options.map(({ option }) => option.name));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(API_SOURCE_FUNCTION_CATALOG.length);
  });
});
