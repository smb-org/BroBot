import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayStatusView } from "../../src/overlay/status";

const versionResponse = (version: string): Response => new Response(
  JSON.stringify({ version }),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

const invalidResponse = (): Response => new Response("", { status: 401 });

const setFragment = (token: string): void => {
  window.history.replaceState(null, "", `/overlay#token=${token}`);
};

describe("Overlay-Statusansicht", () => {
  beforeEach(() => {
    setFragment("erstes-token");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setFragment("");
  });

  it.each([
    ["Backendfehler", invalidResponse()],
    ["Netzwerkfehler", new Error("Netzwerk unterbrochen")],
  ])("bleibt bei einem %s vollständig leer", async (_description, failure) => {
    const fetcher = vi.fn();
    fetcher.mockImplementation(() => failure instanceof Error
      ? Promise.reject(failure)
      : Promise.resolve(failure));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayStatusView />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    expect(container).toBeEmptyDOMElement();
  });

  it("holt nach einem Startfehler ohne Neuladen erneut ab", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("Worker nicht erreichbar"))
      .mockResolvedValueOnce(versionResponse("wieder-da"));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayStatusView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container).toBeEmptyDOMElement();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
    });

    expect(container).toHaveTextContent("Version wieder-da");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("prüft einen geänderten Fragment-Token im selben Dokument erneut", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(versionResponse("alt"))
      .mockResolvedValueOnce(versionResponse("neu"));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayStatusView />);
    await waitFor(() => expect(container).toHaveTextContent("Version alt"));

    act(() => {
      setFragment("zweites-token");
      window.dispatchEvent(new Event("hashchange"));
    });

    await waitFor(() => expect(container).toHaveTextContent("Version neu"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer zweites-token" },
    });
  });

  it("macht einen Widerruf beim nächsten Poll sichtbar unsichtbar", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(versionResponse("laufend"))
      .mockResolvedValueOnce(invalidResponse());
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayStatusView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container).toHaveTextContent("Version laufend");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
    });

    expect(container).toBeEmptyDOMElement();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("vergrößert den Abstand nach wiederholten Fehlern maßvoll", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockRejectedValue(new Error("Worker nicht erreichbar"));
    vi.stubGlobal("fetch", fetcher);

    render(<OverlayStatusView />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_999);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
