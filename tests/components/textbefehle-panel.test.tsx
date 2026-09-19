import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TextbefehlePanel } from "../../src/modules/textbefehle/panel";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Textbefehle-Panel-Ansicht", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("listet Befehle und bietet Bearbeiten und Löschen an", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/befehle") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo {user}",
          cooldownSekunden: 5,
          zuletztVerwendetAt: new Date(Date.now() - 60_000).toISOString(),
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({ befehl: {} }));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextbefehlePanel channelId="kanal-a" />);

    expect(await screen.findByText("!hallo")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "!Name" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Antwort" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Abkühl." })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Zuletzt" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /!hallo.*vor 1 min/ })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Hallo {user}")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("row", { name: /!hallo/ }));
    expect(screen.getByDisplayValue("Hallo {user}")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Eigenschaften von !hallo" })).toHaveTextContent("vor 1 min");
    expect(screen.getByRole("button", { name: "Befehl !hallo speichern" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Befehl !hallo löschen" })).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Hallo {user}"), { target: { value: "Neu {channel}" } });
    fireEvent.click(screen.getByRole("button", { name: "Befehl !hallo speichern" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
  });

  it("hält den Anlege-Knopf bedeckt, bis Pflichtfelder gefüllt sind", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse({ befehle: [] })));
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextbefehlePanel channelId="kanal-a" />);

    const add = await screen.findByRole("button", { name: "Befehl anlegen" });
    expect(add).toBeDisabled();
    expect(add).not.toHaveClass("button--primary");
    expect(screen.getByText(/Name und Antworttext ausfüllen/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "hallo" } });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Antworttext"), { target: { value: "Hallo" } });
    expect(add).toBeEnabled();
    expect(add).toHaveClass("button--primary");
  });

  it("folgt mit dem Panel der Browsersprache", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse({ befehle: [] })));
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });

    render(<TextbefehlePanel channelId="kanal-a" />);

    expect(await screen.findByRole("heading", { name: "Commands" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add command" })).toBeInTheDocument();
  });
});
