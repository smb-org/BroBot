import type { ReactElement } from "react";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Field, UiProvider } from "../../src/dashboard/ui";
import { MembersPage } from "../../src/dashboard/members";
import { PlatformPage } from "../../src/dashboard/platform";
import { ImmediateActions } from "../../src/dashboard/stream-manager";

/**
 * Cross-cutting check for the helper-text rule (editor-konzept 3.0/15.1.3):
 * every `textbox`/`spinbutton`/`radiogroup`/`switch` field carries a
 * non-empty helper line via `aria-describedby`. Scoped to this agent's
 * pages -- members, platform, and the Stream Manager immediate actions --
 * not the module panels (text commands, raid, ads), which are migrating
 * separately and are covered by their own suites.
 */
const renderWithMantine = (element: ReactElement): ReturnType<typeof render> => render(<UiProvider>{element}</UiProvider>);

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const requestUrl = (input: RequestInfo | URL): URL =>
  input instanceof Request ? new URL(input.url) : new URL(String(input), window.location.origin);

const helperTextFor = (field: HTMLElement): string => {
  const describedBy = field.getAttribute("aria-describedby");
  if (describedBy === null || describedBy.trim().length === 0) return "";
  return describedBy
    .split(/\s+/)
    .map((id) => {
      const described = document.getElementById(id);
      return described === null ? "" : described.textContent.trim();
    })
    .filter((text) => text.length > 0)
    .join(" ");
};

/** Every field in `scope` must resolve `aria-describedby` to non-empty text. */
const expectEveryFieldHasHelperText = (scope: HTMLElement): void => {
  const fields = [
    ...within(scope).queryAllByRole("textbox"),
    ...within(scope).queryAllByRole("spinbutton"),
    ...within(scope).queryAllByRole("radiogroup"),
    ...within(scope).queryAllByRole("switch"),
  ];
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) {
    const label = field.getAttribute("aria-label") ?? field.getAttribute("id") ?? field.tagName;
    expect(helperTextFor(field), `helper text for "${label}"`).not.toBe("");
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("helper text on every field (editor-konzept 3.0/15d)", () => {
  it("fails on a field without a hint -- proves the check itself catches a missing helper line", () => {
    const { container } = renderWithMantine(<Field label="Probe" value="" onChange={() => {}} />);
    expect(() => { expectEveryFieldHasHelperText(container); }).toThrow();
  });

  it("gives every Stream Manager immediate-action field a helper text", () => {
    const { container } = renderWithMantine(<ImmediateActions channelId="kanal-a" />);
    expectEveryFieldHasHelperText(container);
  });

  it("gives every field in the members grant editor and member inspector a helper text", () => {
    const member = { userId: "1", login: "mod", displayName: "Mod", profileImageUrl: null, role: "manager" as const, joinedAt: "2026-09-01T00:00:00.000Z" };
    const { container } = renderWithMantine(
      <MembersPage
        channelId="kanal-a"
        ownRole="manager"
        ownUserId="1"
        members={[member]}
        broadcasterCount={1}
        nextCursor={null}
        loading={false}
        loadingNextPage={false}
        error={null}
        onReload={() => Promise.resolve()}
        onLoadNextPage={() => Promise.resolve()}
        onAuthenticationRequired={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("row", { name: /Mod/ }));
    expectEveryFieldHasHelperText(container);

    fireEvent.click(screen.getByRole("button", { name: "Zugriff vergeben" }));
    expectEveryFieldHasHelperText(container);
  });

  it("gives every field in the platform release form and channel inspector a helper text", async () => {
    const channel = {
      channelId: "123",
      login: "alpha_login",
      displayName: "Alpha",
      fullConsent: true,
      memberCounts: { broadcaster: 1, manager: 1, operator: 0 },
      broadcasterConnected: false,
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/platform") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (path === "/api/platform/audit") return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
      if (path === "/api/platform/channels/123/members") return Promise.resolve(jsonResponse({ members: [], nextCursor: null, broadcasterCount: 1, viewerUserId: "999" }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithMantine(<PlatformPage onAuthenticationRequired={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Kanal freigeben" }));
    const freigabe = await screen.findByRole("region", { name: "Kanal freigeben" });
    expectEveryFieldHasHelperText(freigabe);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const inspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    expectEveryFieldHasHelperText(inspector);
  });
});
