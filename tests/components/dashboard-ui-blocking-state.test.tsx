import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockingState, UiProvider } from "../../src/dashboard/ui";

describe("BlockingState", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the action and fires its callback when the viewer can fix it themselves", () => {
    const onClick = vi.fn();
    render(<UiProvider><BlockingState tone="error" title="Der Bot ist nicht angemeldet" description="Nichts empfängt Ereignisse." action={{ label: "Bot anmelden", onClick }} /></UiProvider>);

    expect(screen.getByRole("heading", { name: "Der Bot ist nicht angemeldet", level: 1 })).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Bot anmelden" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("shows who to contact instead of an action when the viewer cannot fix it themselves", () => {
    render(<BlockingState tone="error" title="Der Bot ist nicht angemeldet" description="Nichts empfängt Ereignisse." contact="Wende dich an den Betreiber der Installation." />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Wende dich an den Betreiber der Installation.")).toBeInTheDocument();
  });

  it("does not look like an outage for the neutral tone -- the title stays the regular text color, not error red", () => {
    render(<BlockingState tone="neutral" title="Kanal nicht freigegeben" description="Andere Kanäle sind nicht betroffen." contact="Nur der Betreiber kann freigeben." />);

    const title = screen.getByRole("heading", { name: "Kanal nicht freigegeben" });
    expect(title).toHaveStyle({ color: "rgb(242, 239, 235)" });
  });

  it("marks the bot outage in error red on the title", () => {
    render(<BlockingState tone="error" title="Der Bot ist nicht angemeldet" description="Nichts empfängt Ereignisse." contact="Wende dich an den Betreiber der Installation." />);

    const title = screen.getByRole("heading", { name: "Der Bot ist nicht angemeldet" });
    expect(title).toHaveStyle({ color: "rgb(226, 86, 77)" });
  });
});
