import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayElementPalette, type OverlayElementPaletteMessages, type OverlayElementPaletteOption } from "../../src/dashboard/OverlayElementPalette";
import { UiProvider } from "../../src/dashboard/ui";

afterEach(cleanup);

const options: readonly OverlayElementPaletteOption[] = [
  {
    id: "variable:score",
    groupId: "variables",
    label: "score",
    description: "Current points for the stream.",
    variableName: "score",
    currentValue: "1,234",
    icon: <span aria-hidden="true">V</span>,
  },
  {
    id: "module:ads.countdown",
    groupId: "twitch",
    label: "Ad countdown",
    description: "Time until the next ad break.",
    moduleName: "Ads",
    disabledReason: "Module off · Ads",
    icon: <span aria-hidden="true">A</span>,
  },
];

const messages: OverlayElementPaletteMessages = {
  title: "Add element",
  searchLabel: "Search elements",
  closeLabel: "Close",
  noResults: (query) => `No element matches “${query}”.`,
  keyHints: { navigate: "Navigate", choose: "Add", close: "Close" },
  variablesLabel: "Channel variables",
  categoryLabels: { chat: "Chat", interaction: "Interaction", data: "Data", twitch: "Twitch" },
};

describe("OverlayElementPalette", () => {
  const renderPalette = (optionsToRender: readonly OverlayElementPaletteOption[], onSelect: (option: OverlayElementPaletteOption) => void = () => {}) => render(
    <UiProvider>
      <OverlayElementPalette options={optionsToRender} messages={messages} trigger={<button type="button">Add element</button>} onSelect={onSelect} />
    </UiProvider>,
  );

  it("shows current variable values and keeps disabled module entries searchable", async () => {
    renderPalette(options);
    fireEvent.click(screen.getByRole("button", { name: "Add element" }));

    const listbox = await screen.findByRole("listbox", { name: "Add element", hidden: true });
    expect(within(listbox).getAllByRole("group", { hidden: true }).map((group) => group.getAttribute("aria-label"))).toEqual(["Channel variables", "Twitch"]);
    const variable = await within(listbox).findByRole("option", { name: /score/u, hidden: true });
    expect(variable).toHaveTextContent("Current points for the stream.");
    expect(variable).toHaveTextContent("1,234");
    const disabledModule = within(listbox).getByRole("option", { name: /Ad countdown/u, hidden: true });
    expect(disabledModule).toBeDisabled();
    expect(disabledModule).toHaveTextContent("Module off · Ads");

    const search = screen.getByRole("combobox", { name: "Search elements", hidden: true });
    fireEvent.change(search, { target: { value: "time until ad" } });
    expect(screen.getByRole("option", { name: /Ad countdown/u, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /score/u, hidden: true })).not.toBeInTheDocument();
  });

  it("adds an enabled choice after selection", async () => {
    const onSelect = vi.fn();
    renderPalette(options.slice(0, 1), onSelect);
    fireEvent.click(screen.getByRole("button", { name: "Add element" }));
    fireEvent.click(await screen.findByRole("option", { name: /score/u, hidden: true }));

    expect(onSelect).toHaveBeenCalledWith(options[0]);
  });
});
