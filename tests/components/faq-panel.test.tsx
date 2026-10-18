import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import type { FaqEntry } from "../../src/modules/faq/contracts";
import FaqPanel from "../../src/modules/faq/panel";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const entry: FaqEntry = {
  id: "entry-1",
  name: "Greeting",
  enabled: true,
  matcher: { type: "keywords", patterns: ["hello"] },
  answerText: "Hello there!",
  minimumTier: "everyone",
  cooldownSeconds: 30,
  userCooldownSeconds: 0,
  games: [],
  chatTarget: "source_only",
  order: 0,
  revision: 1,
  lastUsedAt: null,
  createdAt: "2026-09-19T12:00:00.000Z",
  updatedAt: "2026-09-19T12:00:00.000Z",
};

const secondEntry: FaqEntry = {
  ...entry,
  id: "entry-2",
  name: "Support",
  matcher: { type: "keywords", patterns: ["support"] },
  answerText: "Ask a moderator.",
  order: 1,
};

type PanelFetchHandler = (url: URL, method: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

const parseRequestBody = (init: RequestInit | undefined): unknown => {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(init.body) as unknown;
};

const installPanelFetch = (handler?: PanelFetchHandler) => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const handled = await handler?.(url, method, init);
    if (handled !== undefined) return handled;
    if (url.pathname.endsWith("/settings")) return jsonResponse({
      timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
      defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
    });
    if (url.pathname.endsWith("/template-variables")) return jsonResponse({ variables: [] });
    if (url.pathname.endsWith("/entries")) return jsonResponse({ entries: [entry], orderRevision: 1 });
    if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf" });
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

const renderFaqPanel = (language: "de" | "en", options: {
  initialSelection?: string;
  onOpenTestArea?: (moduleId: "text_commands" | "faq", entryId: string) => void;
} = {}) => renderWithQuery(
  <UiProvider><FaqPanel channelId="channel-a" language={language} {...options} /><ToastHost /></UiProvider>,
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const toast of toastsSnapshot()) dismissToast(toast.id);
});

describe("FAQ panel", () => {
  it("opens the saved FAQ entry in the test area and disables the action while dirty", async () => {
    installPanelFetch();
    const onOpenTestArea = vi.fn();
    renderFaqPanel("de", { onOpenTestArea });

    const action = await screen.findByRole("button", { name: "Im Testbereich prüfen" });
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(onOpenTestArea).toHaveBeenCalledWith("faq", "entry-1");

    fireEvent.change(screen.getByRole("textbox", { name: "Antwort" }), { target: { value: "Changed draft" } });
    expect(action).toBeDisabled();
    expect(screen.getByText("Speichere oder verwerfe Änderungen, bevor du prüfst.")).toBeInTheDocument();
  });

  it("saves answer, enabled state, and role threshold together with the entry revision", async () => {
    let updated: FaqEntry = entry;
    const fetcher = installPanelFetch((url, method, init) => {
      if (url.pathname.endsWith("/entries/entry-1") && method === "PATCH") {
        if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
        const body = JSON.parse(init.body) as { answerText: string; enabled: boolean; minimumTier: FaqEntry["minimumTier"]; revision: number };
        expect(body).toMatchObject({ answerText: "Welcome to the channel!", enabled: true, minimumTier: "everyone", revision: 1 });
        updated = { ...entry, answerText: body.answerText, revision: 2 };
        return jsonResponse({ entry: updated });
      }
      return undefined;
    });
    renderFaqPanel("en");

    fireEvent.change(await screen.findByRole("textbox", { name: "Answer" }), { target: { value: "Welcome to the channel!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updated.revision).toBe(2));
    expect(fetcher).toHaveBeenCalledWith("/api/channels/channel-a/modules/faq/entries/entry-1", expect.objectContaining({ method: "PATCH" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });

  it("keeps a stale draft revision after reorder so a concurrent edit cannot be overwritten", async () => {
    let serverEntries = [entry, secondEntry];
    let orderRevision = 1;
    let patchRevision = 0;
    const fetcher = installPanelFetch((url, method, init) => {
      if (url.pathname.endsWith("/entries") && method === "GET") return jsonResponse({ entries: serverEntries, orderRevision });
      if (url.pathname.endsWith("/entries/order") && method === "POST") {
        const request = parseRequestBody(init) as { order: string[]; revision: number };
        expect(request.revision).toBe(1);
        serverEntries = serverEntries.map((candidate) => candidate.id === entry.id
          ? { ...candidate, answerText: "Concurrent manager edit", revision: 2 }
          : candidate);
        serverEntries = request.order.map((id, order) => {
          const candidate = serverEntries.find((item) => item.id === id);
          if (candidate === undefined) throw new Error(`Missing fixture entry ${id}.`);
          return { ...candidate, order };
        });
        orderRevision += 1;
        return jsonResponse({ entries: serverEntries, orderRevision });
      }
      if (url.pathname.endsWith("/entries/entry-1") && method === "PATCH") {
        const request = parseRequestBody(init) as { answerText: string; revision: number };
        patchRevision = request.revision;
        const currentEntry = serverEntries.find((candidate) => candidate.id === entry.id);
        if (request.revision !== currentEntry?.revision) {
          return jsonResponse({ error: "faq_entry_conflict" }, 409);
        }
        return jsonResponse({ entry: currentEntry });
      }
      return undefined;
    });
    renderFaqPanel("en");

    fireEvent.change(await screen.findByRole("textbox", { name: "Answer" }), { target: { value: "My stale draft" } });
    fireEvent.keyDown(screen.getByRole("button", { name: /^Greetinghello$/u }), { key: "ArrowDown", altKey: true });
    await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchRevision).toBe(1));
    expect(serverEntries.find((candidate) => candidate.id === entry.id)?.answerText).toBe("Concurrent manager edit");
    expect(fetcher).toHaveBeenCalledWith("/api/channels/channel-a/modules/faq/entries/entry-1", expect.objectContaining({ method: "PATCH" }));
  });

  it("does not apply the reordered entry revision to a different selected entry", async () => {
    let serverEntries = [entry, secondEntry];
    let orderRevision = 1;
    let finishOrder: (() => void) | undefined;
    let patchRevision = 0;
    installPanelFetch((url, method, init) => {
      if (url.pathname.endsWith("/entries") && method === "GET") return jsonResponse({ entries: serverEntries, orderRevision });
      if (url.pathname.endsWith("/entries/order") && method === "POST") {
        const request = parseRequestBody(init) as { order: string[] };
        return new Promise<Response>((resolve) => {
          finishOrder = () => {
            serverEntries = serverEntries.map((candidate) => candidate.id === entry.id ? { ...candidate, revision: 2 } : candidate);
            serverEntries = request.order.map((id, order) => {
              const candidate = serverEntries.find((item) => item.id === id);
              if (candidate === undefined) throw new Error(`Missing fixture entry ${id}.`);
              return { ...candidate, order };
            });
            orderRevision += 1;
            resolve(jsonResponse({ entries: serverEntries, orderRevision }));
          };
        });
      }
      if (url.pathname.endsWith("/entries/entry-2") && method === "PATCH") {
        patchRevision = (parseRequestBody(init) as { revision: number }).revision;
        const saved = { ...secondEntry, answerText: "Saved support", revision: 2 };
        serverEntries = serverEntries.map((candidate) => candidate.id === secondEntry.id ? saved : candidate);
        return jsonResponse({ entry: saved });
      }
      return undefined;
    });
    renderFaqPanel("en");

    fireEvent.keyDown(await screen.findByRole("button", { name: /^Greetinghello$/u }), { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(finishOrder).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: /^Supportsupport$/u }));
    finishOrder?.();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Support" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "Answer" }), { target: { value: "Saved support" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchRevision).toBe(1));
  });

  it("keeps refreshed content when an undo conflicts after an entry save", async () => {
    let serverEntries = [entry, secondEntry];
    let orderRevision = 1;
    let orderWrites = 0;
    installPanelFetch((url, method, init) => {
      if (url.pathname.endsWith("/entries") && method === "GET") return jsonResponse({ entries: serverEntries, orderRevision });
      if (url.pathname.endsWith("/entries/order") && method === "POST") {
        const request = parseRequestBody(init) as { order: string[]; revision: number };
        orderWrites += 1;
        if (orderWrites === 2) {
          serverEntries = [entry, { ...secondEntry, order: 1 }];
          const savedEntry = serverEntries.find((candidate) => candidate.id === entry.id);
          if (savedEntry !== undefined) serverEntries[0] = { ...savedEntry, answerText: "Saved answer", revision: 2, order: 0 };
          orderRevision += 1;
          return jsonResponse({ error: "faq_entry_order_conflict" }, 409);
        }
        serverEntries = request.order.map((id, order) => {
          const candidate = serverEntries.find((item) => item.id === id);
          if (candidate === undefined) throw new Error(`Missing fixture entry ${id}.`);
          return { ...candidate, order };
        });
        orderRevision += 1;
        return jsonResponse({ entries: serverEntries, orderRevision });
      }
      if (url.pathname.endsWith("/entries/entry-1") && method === "PATCH") {
        const saved = { ...entry, answerText: (parseRequestBody(init) as { answerText: string }).answerText, revision: 2 };
        serverEntries = serverEntries.map((candidate) => candidate.id === entry.id ? saved : candidate);
        return jsonResponse({ entry: saved });
      }
      return undefined;
    });
    renderFaqPanel("en");

    fireEvent.keyDown(await screen.findByRole("button", { name: /^Greetinghello$/u }), { key: "ArrowDown", altKey: true });
    await screen.findByRole("button", { name: "Undo" });
    fireEvent.change(await screen.findByRole("textbox", { name: "Answer" }), { target: { value: "Saved answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(serverEntries.find((candidate) => candidate.id === entry.id)?.answerText).toBe("Saved answer"));
    fireEvent.click(screen.getByRole("button", { name: /^Supportsupport$/u }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(orderWrites).toBe(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("The list was refreshed");
    await waitFor(() => expect(document.querySelectorAll(".faq-panel__entry")[0]).toHaveTextContent("Greeting"));
    fireEvent.click(screen.getByRole("button", { name: /^Greetinghello$/u }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Answer" })).toHaveValue("Saved answer"));
  });

  it("guards navigation when a keyword is still pending in ChipsInput", async () => {
    installPanelFetch((url, method) => url.pathname.endsWith("/entries") && method === "GET"
      ? jsonResponse({ entries: [entry, secondEntry], orderRevision: 1 })
      : undefined);
    renderFaqPanel("de");

    fireEvent.change(await screen.findByRole("textbox", { name: "Schlüsselwörter und Wortgruppen" }), { target: { value: "pending keyword" } });
    fireEvent.click(screen.getByRole("button", { name: /^Supportsupport$/u }));

    expect(await screen.findByRole("dialog", { name: "Ungespeicherte Änderungen" })).toBeInTheDocument();
  });

  it("keeps a rejected keyword in the draft: no save, text kept, guard prompts", async () => {
    const fetcher = installPanelFetch((url, method) => url.pathname.endsWith("/entries") && method === "GET"
      ? jsonResponse({ entries: [entry, secondEntry], orderRevision: 1 })
      : undefined);
    renderFaqPanel("en");

    const field = await screen.findByRole("textbox", { name: "Keywords and phrases" });
    const tooLong = "x".repeat(81);
    fireEvent.change(field, { target: { value: tooLong } });
    fireEvent.blur(field);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Enter 1 to 20 valid keywords or phrases.")).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(field).toHaveValue(tooLong);
    fireEvent.click(screen.getByRole("button", { name: /^Supportsupport$/u }));
    expect(await screen.findByRole("dialog", { name: "Unsaved changes" })).toBeInTheDocument();
  });

  it("Discard clears a rejected keyword so the draft is clean again", async () => {
    installPanelFetch((url, method) => url.pathname.endsWith("/entries") && method === "GET"
      ? jsonResponse({ entries: [entry, secondEntry], orderRevision: 1 })
      : undefined);
    renderFaqPanel("en");

    const field = await screen.findByRole("textbox", { name: "Keywords and phrases" });
    fireEvent.change(field, { target: { value: "x".repeat(81) } });
    fireEvent.blur(field);
    expect(field).toHaveValue("x".repeat(81));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(field).toHaveValue("");
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /^Supportsupport$/u }));
    expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument();
  });
});
