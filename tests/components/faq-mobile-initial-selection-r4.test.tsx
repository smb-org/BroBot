import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import FaqPanel from "../../src/modules/faq/panel";
import type { FaqEntry } from "../../src/modules/faq/contracts";
import TextCommandsPanel from "../../src/modules/text_commands/panel";
import type { TextCommand } from "../../src/modules/text_commands/contracts";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const faqEntry: FaqEntry = {
  id: "faq-entry-a",
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
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
};

const textCommand: TextCommand = {
  channelId: "channel-a",
  name: "hello",
  text: "Hello {user}",
  kind: "text",
  enabled: true,
  minimumTier: "everyone",
  cooldownSeconds: 0,
  aliases: [],
  userCooldownSeconds: 0,
  streamCondition: "any",
  responseType: "reply",
  chatTarget: "source_only",
  variableAction: null,
  timeoutAction: null,
  useCount: 0,
  lastUsedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
  revision: 1,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FAQ editor deep links on narrow layouts", () => {
  it("opens the selected FAQ detail when entered from the test area", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
      if (this.classList.contains("main-content")) {
        return new DOMRect(0, 0, 390, 800);
      }
      return new DOMRect(0, 0, 0, 0);
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/entries")) return Promise.resolve(jsonResponse({ entries: [faqEntry], orderRevision: 1 }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(
      <UiProvider>
        <main className="main-content" style={{ width: 390, padding: 0 }}>
          <FaqPanel channelId="channel-a" language="en" initialSelection="faq-entry-a" />
        </main>
      </UiProvider>,
    );

    await waitFor(() => expect(document.querySelector(".collection-page")).toHaveAttribute("data-single-column", "true"));
    await waitFor(() => expect(document.querySelector(".collection-page")).toHaveAttribute("data-detail-open", "true"));
    expect(await screen.findByRole("textbox", { name: "Answer" })).toBeInTheDocument();
  });

  it("opens the selected text command detail when entered from the test area", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
      if (this.classList.contains("main-content")) {
        return new DOMRect(0, 0, 390, 800);
      }
      return new DOMRect(0, 0, 0, 0);
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/commands")) return Promise.resolve(jsonResponse({ commands: [textCommand], variables: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(
      <UiProvider>
        <main className="main-content" style={{ width: 390, padding: 0 }}>
          <TextCommandsPanel channelId="channel-a" language="de" initialSelection="hello" />
        </main>
      </UiProvider>,
    );

    await waitFor(() => expect(document.querySelector(".collection-page")).toHaveAttribute("data-single-column", "true"));
    await waitFor(() => expect(document.querySelector(".collection-page")).toHaveAttribute("data-detail-open", "true"));
    expect(await screen.findByRole("textbox", { name: "Antworttext" })).toBeInTheDocument();
  });
});
