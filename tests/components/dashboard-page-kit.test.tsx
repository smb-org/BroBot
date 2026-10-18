import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { CollectionPage, RuleNote, SettingsPage, ToolPage } from "../../src/dashboard/ui";

afterEach(cleanup);

describe("dashboard page layouts", () => {
  it("exports the shared RuleNote component from the dashboard kit", () => {
    render(<RuleNote>Shared rule</RuleNote>);

    expect(screen.getByText("Shared rule")).toBeInTheDocument();
  });

  it("keeps the collection list and detail in named slots", () => {
    const { container } = render(<CollectionPage
      title="Commands"
      toolbar={<button type="button">Create</button>}
      list={<button type="button">!hello</button>}
      detail={<p>Command details</p>}
    />);

    expect(screen.getByRole("heading", { level: 1, name: "Commands" })).toBeInTheDocument();
    expect(container.querySelector(".collection-page__list-toolbar")).toContainElement(screen.getByRole("button", { name: "Create" }));
    expect(container.querySelector(".collection-page__list-content")).toContainElement(screen.getByRole("button", { name: "!hello" }));
    expect(container.querySelector(".collection-page__detail")).toHaveTextContent("Command details");
  });

  it("returns focus to the latest opened row when the detail closes", async () => {
    function Harness() {
      const [selected, setSelected] = useState<string | null>(null);
      return <CollectionPage
        title="Members"
        toolbar={null}
        detailOpen={selected !== null}
        onCloseDetail={() => { setSelected(null); }}
        list={<>{["A", "B"].map((id) => <button key={id} type="button" onClick={() => { setSelected(id); }}>{`Member ${id}`}</button>)}</>}
        detail={<button type="button" onClick={() => { setSelected(null); }}>Close</button>}
      />;
    }
    render(<Harness />);
    const rowA = screen.getByRole("button", { name: "Member A" });
    const rowB = screen.getByRole("button", { name: "Member B" });
    rowA.focus();
    fireEvent.click(rowA);
    rowB.focus();
    fireEvent.click(rowB);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => { expect(rowB).toHaveFocus(); });
  });

  it("places settings sections into internally scrollable columns", () => {
    const { container } = render(<SettingsPage title="Settings" columns={[<p key="first">First</p>, <p key="second">Second</p>]} />);

    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(container.querySelector(".settings-page__columns")).toHaveClass("settings-page__columns--2");
    expect(container.querySelectorAll(".settings-page__column")).toHaveLength(2);
  });

  it("gives tool content a full-area body below its page header", () => {
    const { container } = render(<ToolPage title="Overlay editor"><p>Workspace</p></ToolPage>);

    expect(screen.getByRole("heading", { level: 1, name: "Overlay editor" })).toBeInTheDocument();
    expect(container.querySelector(".tool-page__body")).toHaveTextContent("Workspace");
  });
});
