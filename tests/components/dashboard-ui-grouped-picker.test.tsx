import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GroupedPicker, UiProvider, type GroupedPickerGroup, type GroupedPickerMessages } from "../../src/dashboard/ui";

afterEach(cleanup);

const renderPicker = (content: ReactNode): ReturnType<typeof render> => render(<UiProvider>{content}</UiProvider>);

const messages: GroupedPickerMessages = {
  title: "Choose an element",
  searchLabel: "Search elements",
  closeLabel: "Close",
  noResults: (query) => `No element matches “${query}”.`,
  keyHints: { navigate: "navigate", choose: "choose", close: "close" },
};

const groups: readonly GroupedPickerGroup[] = [
  {
    id: "data",
    label: "Data",
    entries: [
      { id: "viewers", label: "Viewers", description: "Current viewer count", icon: <span aria-hidden="true">◉</span>, trailing: <span>24</span> },
      { id: "disabled", label: "Disabled entry", description: "Not available", icon: <span aria-hidden="true">◇</span>, disabled: true, disabledReason: "Module off" },
      { id: "poll", label: "Poll result", description: "Current poll winner", icon: <span aria-hidden="true">▤</span> },
    ],
  },
];

describe("GroupedPicker", () => {
  it("groups options, skips disabled entries with arrows, selects with Enter, and restores focus", async () => {
    const onSelect = vi.fn();
    const onDismissFocus = vi.fn();
    renderPicker(<GroupedPicker groups={groups} messages={messages} trigger={<button type="button">Add element</button>} onSelect={onSelect} onDismissFocus={onDismissFocus} footer="Element limit" />);

    const trigger = screen.getByRole("button", { name: "Add element" });
    fireEvent.click(trigger);
    const search = await screen.findByRole("combobox", { name: "Search elements" });
    await waitFor(() => expect(document.activeElement).toBe(search));

    const listbox = screen.getByRole("listbox", { name: "Choose an element", hidden: true });
    expect(within(listbox).getByRole("group", { name: "Data", hidden: true })).toBeInTheDocument();
    expect(within(listbox).getByText("24")).toBeInTheDocument();
    expect(screen.getByText("Element limit")).toBeInTheDocument();
    const disabled = within(listbox).getByRole("option", { name: /Disabled entry/u, hidden: true });
    expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect(disabled).toHaveTextContent("Module off");

    const viewers = within(listbox).getByRole("option", { name: /Viewers/u, hidden: true });
    const poll = within(listbox).getByRole("option", { name: /Poll result/u, hidden: true });
    expect(viewers).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(poll).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(groups[0]?.entries[2]);
    await waitFor(() => expect(onDismissFocus).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Choose an element", hidden: true })).not.toBeInTheDocument());
  });

  it("filters labels and descriptions and uses the search term in the empty state", async () => {
    renderPicker(<GroupedPicker groups={groups} messages={messages} trigger={<button type="button">Add element</button>} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add element" }));
    const search = await screen.findByRole("combobox", { name: "Search elements" });

    fireEvent.change(search, { target: { value: "current poll" } });
    expect(screen.getByRole("option", { name: /Poll result/u, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Viewers/u, hidden: true })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("No element matches “missing”.");
  });

  it("uses a custom entry matcher and renders the bottom sheet on small screens", async () => {
    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: query === "(max-width: 599px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    try {
      renderPicker(<GroupedPicker
        groups={groups}
        messages={messages}
        trigger={<button type="button">Add element</button>}
        onSelect={() => {}}
        filterEntry={(entry, query) => entry.id.includes(query)}
      />);
      fireEvent.click(screen.getByRole("button", { name: "Add element" }));

      const search = await screen.findByRole("combobox", { name: "Search elements" });
      expect(document.querySelector(".ui-grouped-picker__drawer-content .ui-grouped-picker--sheet")).toBeInTheDocument();
      await waitFor(() => expect(document.activeElement).toBe(search));
      expect(screen.getByRole("dialog", { name: "Choose an element" })).toBeInTheDocument();
      fireEvent.change(search, { target: { value: "poll" } });
      expect(screen.getByRole("option", { name: /Poll result/u, hidden: true })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /Viewers/u, hidden: true })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Close", hidden: true }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add element" })));
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("closes with Escape and restores focus to its trigger", async () => {
    renderPicker(<GroupedPicker groups={groups} messages={messages} trigger={<button type="button">Add element</button>} onSelect={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Add element" });
    fireEvent.click(trigger);
    const search = await screen.findByRole("combobox", { name: "Search elements" });

    fireEvent.keyDown(search, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Choose an element", hidden: true })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes with Escape pressed on a non-search element inside the popover", async () => {
    renderPicker(<GroupedPicker groups={groups} messages={messages} trigger={<button type="button">Add element</button>} onSelect={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Add element" });
    fireEvent.click(trigger);
    const option = (await screen.findByRole("option", { name: /Viewers/u, hidden: true }));

    fireEvent.keyDown(option, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Choose an element", hidden: true })).not.toBeInTheDocument());
  });

  it("supports controlled visibility", async () => {
    function ControlledPicker() {
      const [opened, setOpened] = useState(false);
      return <GroupedPicker
        groups={groups}
        messages={messages}
        trigger={<button type="button">Add element</button>}
        onSelect={() => {}}
        opened={opened}
        onOpenedChange={setOpened}
      />;
    }

    renderPicker(<ControlledPicker />);
    fireEvent.click(screen.getByRole("button", { name: "Add element" }));

    expect(await screen.findByRole("listbox", { name: "Choose an element", hidden: true })).toBeInTheDocument();
  });

  it("does not run a stale focus restore when reopened during the exit transition", async () => {
    const exitAnimations: Array<() => void> = [];
    const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value(this: Element) {
        if (!this.hasAttribute("data-ending-style")) return [];
        return [{
          effect: {
            getTiming: () => ({ duration: 150, iterations: 1 }),
            getComputedTiming: () => ({ duration: 150, iterations: 1 }),
          },
          finished: new Promise<void>((resolve) => { exitAnimations.push(resolve); }),
        }];
      },
    });
    try {
    function ControlledPicker() {
      const [opened, setOpened] = useState(false);
      return <>
        <button type="button" onClick={() => setOpened(false)}>Programmatic close</button>
        <GroupedPicker
          groups={groups}
          messages={messages}
          trigger={<button type="button">Add element</button>}
          onSelect={() => {}}
          opened={opened}
          onOpenedChange={setOpened}
        />
      </>;
    }

    renderPicker(<ControlledPicker />);
    const trigger = screen.getByRole("button", { name: "Add element" });
    fireEvent.click(trigger);
    const search = await screen.findByRole("combobox", { name: "Search elements" });
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(exitAnimations.length).toBeGreaterThan(0));
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await act(async () => {
      for (const finishExit of exitAnimations.splice(0)) finishExit();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Programmatic close"));
    await waitFor(() => expect(exitAnimations.length).toBeGreaterThan(0));
    await act(async () => {
      for (const finishExit of exitAnimations.splice(0)) finishExit();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Choose an element", hidden: true })).not.toBeInTheDocument());
    expect(document.activeElement).not.toBe(trigger);
    } finally {
      if (originalGetAnimations === undefined) delete (Element.prototype as Partial<Element>).getAnimations;
      else Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
    }
  });

  it("calls onDismissFocus right after close, before the exit transition ends", async () => {
    const onDismissFocus = vi.fn();
    const finishExits: (() => void)[] = [];
    const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value(this: Element) {
        if (!this.hasAttribute("data-ending-style")) return [];
        return [{
          effect: {
            getTiming: () => ({ duration: 150, iterations: 1 }),
            getComputedTiming: () => ({ duration: 150, iterations: 1 }),
          },
          finished: new Promise<void>((resolve) => { finishExits.push(resolve); }),
        }];
      },
    });
    try {
    renderPicker(<GroupedPicker groups={groups} messages={messages} trigger={<button type="button">Add element</button>} onSelect={() => {}} onDismissFocus={onDismissFocus} />);
    fireEvent.click(screen.getByRole("button", { name: "Add element" }));
    const search = await screen.findByRole("combobox", { name: "Search elements" });
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(onDismissFocus).toHaveBeenCalledOnce());
    expect(screen.queryByRole("combobox", { name: "Search elements", hidden: true })).toBeInTheDocument();
    await waitFor(() => expect(finishExits.length).toBeGreaterThan(0));
    act(() => { for (const finishExit of finishExits) finishExit(); });
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search elements", hidden: true })).not.toBeInTheDocument());
    } finally {
      if (originalGetAnimations === undefined) delete (Element.prototype as Partial<Element>).getAnimations;
      else Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
    }
  });

  it("does not move focus to the trigger after the exit when focus went elsewhere meanwhile", async () => {
    const exitAnimations: Array<() => void> = [];
    const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value(this: Element) {
        if (!this.hasAttribute("data-ending-style")) return [];
        return [{
          effect: {
            getTiming: () => ({ duration: 150, iterations: 1 }),
            getComputedTiming: () => ({ duration: 150, iterations: 1 }),
          },
          finished: new Promise<void>((resolve) => { exitAnimations.push(resolve); }),
        }];
      },
    });
    try {
      renderPicker(<>
        <textarea aria-label="Editor" />
        <GroupedPicker groups={groups} messages={messages} trigger={<button type="button">Add element</button>} onSelect={() => {}} />
      </>);
      fireEvent.click(screen.getByRole("button", { name: "Add element" }));
      const search = await screen.findByRole("combobox", { name: "Search elements" });
      fireEvent.keyDown(search, { key: "Escape" });
      await waitFor(() => expect(exitAnimations.length).toBeGreaterThan(0));
      const editor = screen.getByRole("textbox", { name: "Editor" });
      editor.focus();
      await act(async () => {
        for (const finishExit of exitAnimations.splice(0)) finishExit();
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search elements" })).not.toBeInTheDocument());
      expect(document.activeElement).toBe(editor);
    } finally {
      if (originalGetAnimations === undefined) delete (Element.prototype as Partial<Element>).getAnimations;
      else Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
    }
  });

  it("restores focus to the trigger after a zero-duration (reduced motion) exit on small screens", async () => {
    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: query === "(max-width: 599px)" || query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    try {
      render(<UiProvider>
        <textarea aria-label="Editor" />
        <GroupedPicker
          groups={groups}
          messages={messages}
          trigger={<button type="button">Add element</button>}
          onSelect={() => {}}
        />
      </UiProvider>);
      fireEvent.click(screen.getByRole("button", { name: "Add element" }));
      await screen.findByRole("combobox", { name: "Search elements" });
      fireEvent.click(screen.getByRole("button", { name: "Close", hidden: true }));
      await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search elements" })).not.toBeInTheDocument());
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add element" })));
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("clears the pending exit timer when unmounted", async () => {
    vi.useFakeTimers();
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const getComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const styles = getComputedStyle(element);
      if (!element.classList.contains("ui-grouped-picker__popover")) return styles;
      Object.defineProperties(styles, {
        transitionDuration: { configurable: true, value: "500ms" },
        transitionDelay: { configurable: true, value: "0s" },
      });
      return styles;
    });
    const setTimeout = vi.spyOn(window, "setTimeout");
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    try {
      const { unmount } = renderPicker(<GroupedPicker groups={groups} messages={messages} trigger={<button type="button">Add element</button>} onSelect={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Add element" }));
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Search elements" }), { key: "Escape" });
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });

      const closeTimerIndexes = setTimeout.mock.calls.flatMap(([, delay], index) => delay === 500 ? [index] : []);
      expect(closeTimerIndexes).toHaveLength(1);
      const closeTimer = setTimeout.mock.results[closeTimerIndexes[0] ?? -1]?.value as ReturnType<typeof window.setTimeout> | undefined;
      unmount();
      expect(clearTimeout).toHaveBeenCalledWith(closeTimer);
      Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      if (originalDocument !== undefined) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      cleanup();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
