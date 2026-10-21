import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonResponseTree } from "../../src/modules/api_source/panel/JsonResponseTree";
import type { ApiSourceJsonTreeMessages } from "../../src/modules/api_source/panel/JsonResponseTree";

const messages: ApiSourceJsonTreeMessages = {
  treeLabel: "Sample JSON response",
  responseRoot: "Response",
  emptyKey: "Empty key",
  loading: "Loading response",
  empty: "Run a test to inspect a JSON response",
  types: { array: "Array", boolean: "Boolean", null: "Null", number: "Number", object: "Object", string: "String" },
  moreEntries: (count) => `+${String(count)} more`,
  pathTooLong: "This path exceeds the expression limit.",
  pathUnsupported: "This path is not supported by the evaluator.",
};

describe("API source JSON response tree", () => {
  afterEach(cleanup);

  it("renders object, array, and leaf types", () => {
    render(<JsonResponseTree value={{ temperature: 21, days: ["today"], enabled: true, missing: null, "": "empty key" }}
      messages={messages} onSelectPath={vi.fn()} />);

    const tree = screen.getByRole("tree", { name: messages.treeLabel });
    expect(within(tree).getByRole("treeitem", { name: /Response.*Object/iu })).toBeInTheDocument();
    expect(within(tree).getByRole("treeitem", { name: /days.*Array/u })).toHaveAttribute("aria-expanded", "true");
    expect(within(tree).getByRole("treeitem", { name: /temperature.*Number.*21/u })).toBeInTheDocument();
    expect(within(tree).getByRole("treeitem", { name: /enabled.*Boolean.*true/u })).toBeInTheDocument();
    expect(within(tree).getByRole("treeitem", { name: /missing.*Null.*null/u })).toBeInTheDocument();
    expect(within(tree).getByRole("treeitem", { name: /Empty key.*String.*empty key/u })).toBeInTheDocument();
  });

  it("expands and collapses nested entries", () => {
    render(<JsonResponseTree value={{ weather: { daily: { sunrise: "06:18" } } }}
      messages={messages} onSelectPath={vi.fn()} />);

    const daily = screen.getByRole("treeitem", { name: /daily/u });
    expect(daily).toHaveAttribute("aria-expanded", "false");
    const dailyRow = daily.querySelector(".api-source-json-tree__item");
    if (!(dailyRow instanceof HTMLElement)) throw new Error("Daily tree row is missing.");
    fireEvent.click(dailyRow);
    expect(screen.getByRole("treeitem", { name: /sunrise/u })).toBeInTheDocument();
    const expandedDailyRow = daily.querySelector(".api-source-json-tree__item");
    if (!(expandedDailyRow instanceof HTMLElement)) throw new Error("Expanded daily tree row is missing.");
    fireEvent.click(expandedDailyRow);
    expect(screen.queryByRole("treeitem", { name: /sunrise/u })).not.toBeInTheDocument();
  });

  it("moves focus and expands or collapses with the arrow keys", () => {
    render(<JsonResponseTree value={{ weather: { daily: { sunrise: "06:18" } } }}
      messages={messages} onSelectPath={vi.fn()} />);

    const response = screen.getByRole("treeitem", { name: /Response/iu });
    response.focus();
    fireEvent.keyDown(response, { key: "ArrowDown" });
    const weather = screen.getByRole("treeitem", { name: /weather/u });
    expect(weather).toHaveFocus();
    fireEvent.keyDown(weather, { key: "ArrowDown" });
    const daily = screen.getByRole("treeitem", { name: /daily/u });
    fireEvent.keyDown(daily, { key: "ArrowRight" });
    expect(daily).toHaveAttribute("aria-expanded", "true");
    const sunrise = screen.getByRole("treeitem", { name: /sunrise/u });
    expect(sunrise).toBeInTheDocument();
    fireEvent.keyDown(daily, { key: "ArrowRight" });
    expect(sunrise).toHaveFocus();
    fireEvent.keyDown(sunrise, { key: "ArrowLeft" });
    expect(daily).toHaveFocus();
    fireEvent.keyDown(daily, { key: "ArrowLeft" });
    expect(daily).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /sunrise/u })).not.toBeInTheDocument();
    fireEvent.keyDown(daily, { key: "ArrowUp" });
    expect(screen.getByRole("treeitem", { name: /weather/u })).toHaveFocus();
  });

  it("selects a leaf path when clicked or activated from the keyboard", () => {
    const onSelectPath = vi.fn();
    render(<JsonResponseTree value={{ weather: { temperature: 21 } }} messages={messages} onSelectPath={onSelectPath} />);

    const leaf = screen.getByRole("treeitem", { name: /temperature/u });
    const leafRow = leaf.querySelector(".api-source-json-tree__item");
    if (!(leafRow instanceof HTMLElement)) throw new Error("Temperature tree row is missing.");
    fireEvent.click(leafRow);
    expect(onSelectPath).toHaveBeenLastCalledWith("$.weather.temperature");
    fireEvent.keyDown(leaf, { key: "Enter" });
    expect(onSelectPath).toHaveBeenLastCalledWith("$.weather.temperature");
    fireEvent.keyDown(leaf, { key: " " });
    expect(onSelectPath).toHaveBeenLastCalledWith("$.weather.temperature");
  });

  it("keeps long responses bounded and explains paths the evaluator cannot accept", () => {
    const longValue = "a".repeat(80);
    const entries: [string, unknown][] = [
      ["long", longValue],
      ["x".repeat(600), "not selectable"],
      ...Array.from({ length: 101 }, (_, index): [string, number] => [`entry${String(index)}`, index]),
    ];
    const value = Object.fromEntries(entries);
    render(<JsonResponseTree value={value} messages={messages} onSelectPath={vi.fn()} />);

    const longLeaf = screen.getByRole("treeitem", { name: /long/u });
    expect(longLeaf).toHaveAttribute("title", longValue);
    expect(longLeaf.textContent.length).toBeLessThan(longValue.length + 20);
    expect(screen.getByText("+3 more")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /entry100/u })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /not selectable/u })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("treeitem", { name: /not selectable/u })).toHaveAttribute("title", messages.pathTooLong);
  });
});
