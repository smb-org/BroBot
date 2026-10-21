import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog } from "../../src/dashboard/ui";
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
  treeBudgetExceeded: "This branch cannot open because the response display limit has been reached.",
};

describe("API source JSON response tree", () => {
  afterEach(cleanup);

  it("renders object, array, and leaf types", () => {
    render(<JsonResponseTree value={{ temperature: 21, days: ["today"], enabled: true, missing: null, "": "empty key" }}
      expression="" messages={messages} onSelectPath={vi.fn()} />);

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
      expression="" messages={messages} onSelectPath={vi.fn()} />);

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
    render(<>
      <button type="button">Before tree</button>
      <JsonResponseTree value={{ weather: { daily: { sunrise: "06:18" } } }}
        expression="" messages={messages} onSelectPath={vi.fn()} />
      <button type="button">After tree</button>
    </>);

    const response = screen.getByRole("treeitem", { name: /Response/iu });
    response.focus();
    fireEvent.keyDown(response, { key: "ArrowDown" });
    const weather = screen.getByRole("treeitem", { name: /weather/u });
    expect(weather).toHaveFocus();
    expect(weather).toHaveAttribute("tabindex", "0");
    expect(response).toHaveAttribute("tabindex", "-1");

    screen.getByRole("button", { name: "After tree" }).focus();
    expect(weather).toHaveAttribute("tabindex", "0");
    weather.focus();
    expect(weather).toHaveFocus();
    expect(weather).toHaveAttribute("tabindex", "0");
    expect(response).toHaveAttribute("tabindex", "-1");

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

  it("moves focus without rerendering the tree", () => {
    let commitCount = 0;
    render(<Profiler id="json-response-tree" onRender={() => { commitCount += 1; }}>
      <JsonResponseTree value={{ first: 1, second: 2 }} expression="" messages={messages} onSelectPath={vi.fn()} />
    </Profiler>);
    const committedBeforeFocus = commitCount;

    const response = screen.getByRole("treeitem", { name: /Response/iu });
    response.focus();
    fireEvent.keyDown(response, { key: "ArrowDown" });

    expect(screen.getByRole("treeitem", { name: /first/u })).toHaveFocus();
    expect(commitCount).toBe(committedBeforeFocus);
  });

  it("moves focus to the root when a replacement response removes the focused item", () => {
    const view = render(<JsonResponseTree value={{ previous: 1 }} expression="" messages={messages} onSelectPath={vi.fn()} />);
    const previous = screen.getByRole("treeitem", { name: /previous/u });
    previous.focus();
    expect(previous).toHaveFocus();

    view.rerender(<JsonResponseTree value={{ current: 2 }} expression="" messages={messages} onSelectPath={vi.fn()} />);

    expect(screen.getByRole("treeitem", { name: /Response/iu })).toHaveFocus();
    expect(screen.getByRole("treeitem", { name: /current/u })).toBeInTheDocument();
  });

  it("selects a leaf path when clicked or activated from the keyboard", () => {
    const onSelectPath = vi.fn();
    render(<JsonResponseTree value={{ weather: { temperature: 21 } }} expression="" messages={messages} onSelectPath={onSelectPath} />);

    const leaf = screen.getByRole("treeitem", { name: /temperature/u });
    const leafRow = leaf.querySelector(".api-source-json-tree__item");
    if (!(leafRow instanceof HTMLElement)) throw new Error("Temperature tree row is missing.");
    fireEvent.click(leafRow);
    expect(onSelectPath).toHaveBeenLastCalledWith("$.weather.temperature");
    expect(onSelectPath).toHaveBeenCalledTimes(1);
    onSelectPath.mockClear();
    fireEvent.keyDown(leaf, { key: "Enter" });
    expect(onSelectPath).toHaveBeenLastCalledWith("$.weather.temperature");
    expect(onSelectPath).toHaveBeenCalledTimes(1);
    onSelectPath.mockClear();
    fireEvent.keyDown(leaf, { key: " " });
    expect(onSelectPath).toHaveBeenLastCalledWith("$.weather.temperature");
    expect(onSelectPath).toHaveBeenCalledTimes(1);
  });

  it("selects root array leaves using generated numeric root paths", () => {
    const onSelectPath = vi.fn();
    render(<JsonResponseTree value={[{ v: 1 }, { v: 2 }]} expression="" messages={messages} onSelectPath={onSelectPath} />);

    const firstValue = screen.getByRole("treeitem", { name: /v, Number, 1/u });
    const row = firstValue.querySelector(".api-source-json-tree__item");
    if (!(row instanceof HTMLElement)) throw new Error("First root array value row is missing.");
    fireEvent.click(row);

    expect(onSelectPath).toHaveBeenCalledOnce();
    expect(onSelectPath).toHaveBeenCalledWith("$[0].v");
  });

  it("derives selected leaves from the current expression", () => {
    const onSelectPath = vi.fn();
    const view = render(<JsonResponseTree value={{ weather: { temperature: 21, enabled: true } }}
      expression="$.weather.temperature" messages={messages} onSelectPath={onSelectPath} />);

    const temperature = screen.getByRole("treeitem", { name: /temperature/u });
    const enabled = screen.getByRole("treeitem", { name: /enabled/u });
    expect(temperature).toHaveAttribute("aria-selected", "true");
    expect(enabled).toHaveAttribute("aria-selected", "false");

    view.rerender(<JsonResponseTree value={{ weather: { temperature: 21, enabled: true } }}
      expression="$.weather.enabled" messages={messages} onSelectPath={onSelectPath} />);

    expect(screen.getByRole("treeitem", { name: /temperature/u })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("treeitem", { name: /enabled/u })).toHaveAttribute("aria-selected", "true");
  });

  it("allows Escape from a tree item to close its dialog", async () => {
    const EscapeDialog = () => {
      const [opened, setOpened] = useState(true);
      return <Dialog opened={opened} title="JSON response" onClose={() => { setOpened(false); }}>
        <JsonResponseTree value={{ weather: { temperature: 21 } }} expression="" messages={messages} onSelectPath={vi.fn()} />
      </Dialog>;
    };
    render(<EscapeDialog />);

    fireEvent.keyDown(await screen.findByRole("treeitem", { name: /Response/iu }), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "JSON response" })).not.toBeInTheDocument());
  });

  it("keeps long responses bounded and explains paths the evaluator cannot accept", () => {
    const longValue = "a".repeat(80);
    const entries: [string, unknown][] = [
      ["long", longValue],
      ["x".repeat(600), "not selectable"],
      ...Array.from({ length: 101 }, (_, index): [string, number] => [`entry${String(index)}`, index]),
    ];
    const value = Object.fromEntries(entries);
    render(<JsonResponseTree value={value} expression="" messages={messages} onSelectPath={vi.fn()} />);

    const longLeaf = screen.getByRole("treeitem", { name: /long/u });
    expect(longLeaf).toHaveAttribute("title", longValue);
    expect(longLeaf.textContent.length).toBeLessThan(longValue.length + 20);
    expect(screen.getByText("+3 more")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /entry100/u })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /not selectable/u })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("treeitem", { name: /not selectable/u })).toHaveAttribute("title", messages.pathTooLong);
  });

  it("keeps a broad nested response within the global tree item budget", () => {
    const value = Object.fromEntries(Array.from({ length: 100 }, (_unused, arrayIndex) => [
      `array${String(arrayIndex)}`,
      Array.from({ length: 100 }, (_unusedValue, valueIndex) => valueIndex),
    ]));
    render(<JsonResponseTree value={value} expression="" messages={messages} onSelectPath={vi.fn()} />);

    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(500);
    expect(screen.getAllByText(/^\+\d+ more$/u).length).toBeGreaterThan(0);
  });

  it("prioritizes an explicitly expanded branch at the exact tree item budget", () => {
    const value = [
      ...Array.from({ length: 4 }, () => Array.from({ length: 100 }, (_unused, index) => index)),
      [...Array.from({ length: 93 }, (_unused, index) => index), [99]],
    ];
    render(<JsonResponseTree value={value} expression="" messages={messages} onSelectPath={vi.fn()} />);

    expect(screen.getAllByRole("treeitem")).toHaveLength(500);
    const nestedArray = screen.getByRole("treeitem", { name: /\[93\].*Array/u });
    expect(nestedArray).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(nestedArray, { key: "ArrowRight" });

    expect(nestedArray).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: /\[0\].*Number.*99/u })).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(500);
  });
});
