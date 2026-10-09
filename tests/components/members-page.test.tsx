import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MembersPage } from "../../src/dashboard/members";
import { membersTexts } from "../../src/dashboard/labels";
import { UiProvider } from "../../src/dashboard/ui";
import type { PanelMember, PanelMembersResponse } from "../../src/panel-contract";
import { dashboardDataKeys } from "../../src/dashboard/data/keys";
import { renderWithQuery } from "../query-test-utils";

const member = (overrides: Partial<PanelMember> = {}): PanelMember => ({
  userId: "operator",
  login: "helper",
  displayName: "Chat helper",
  profileImageUrl: null,
  role: "operator",
  joinedAt: "2026-09-18T00:00:00.000Z",
  ...overrides,
});

const renderMembers = (
  ownRole: "broadcaster" | "manager" | "operator",
  response: PanelMembersResponse = { members: [], nextCursor: null, broadcasterCount: 1, viewerUserId: "viewer" },
) => renderWithQuery(
  <UiProvider><MembersPage channelId="channel-a" ownRole={ownRole} onAuthenticationRequired={() => undefined} /></UiProvider>,
  undefined,
  { initialData: [{ queryKey: dashboardDataKeys.members("channel-a"), data: { pages: [response], pageParams: [null] } }] },
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("members list permissions", () => {
  it.each([
    ["broadcaster", false],
    ["manager", false],
    ["operator", true],
  ] as const)("keeps the grant button and reason consistent for %s", (role, disabled) => {
    renderMembers(role);

    const grantButton = screen.getByRole("button", { name: membersTexts().grantAccessTitle });
    const reasonId = grantButton.getAttribute("aria-describedby");
    const reason = reasonId === null ? null : document.getElementById(reasonId);
    expect(grantButton).toBeInTheDocument();
    expect(grantButton).toHaveProperty("disabled", disabled);
    if (disabled) {
      expect(reason).toBeInTheDocument();
      expect(reasonId).not.toBeNull();
      expect(reason).toBeVisible();
      expect(reason).toHaveTextContent(membersTexts().managementLocked);
      expect(reason).not.toHaveAttribute("aria-hidden");
    } else {
      expect(reasonId).toBeNull();
      expect(reason).toBeNull();
    }
  });

  it("keeps member-list errors out of the list flow", () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);
    renderWithQuery(<UiProvider><MembersPage channelId="channel-a" ownRole="manager" onAuthenticationRequired={() => undefined} /></UiProvider>);

    return waitFor(() => {
      expect(fetcher).toHaveBeenCalled();
      expect(document.querySelector(".content-section .form-error")).toBeNull();
    });
  });

  it("shows a Retry action after the initial member query fails", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ members: [member()], nextCursor: null, broadcasterCount: 1, viewerUserId: "viewer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><MembersPage channelId="channel-a" ownRole="manager" onAuthenticationRequired={() => undefined} /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Chat helper")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps cached members visible and offers Retry after a background failure", async () => {
    const cachedMember = member();
    const refreshedMember = member({ userId: "operator-2", displayName: "New helper" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ members: [refreshedMember], nextCursor: null, broadcasterCount: 1, viewerUserId: "viewer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetcher);

    const rendered = renderWithQuery(
      <UiProvider><MembersPage channelId="channel-a" ownRole="manager" onAuthenticationRequired={() => undefined} /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{
          queryKey: dashboardDataKeys.members("channel-a"),
          data: { pages: [{ members: [cachedMember], nextCursor: null, broadcasterCount: 1, viewerUserId: "viewer" }], pageParams: [null] },
        }],
      },
    );

    expect(screen.getByText("Chat helper")).toBeVisible();
    await act(async () => {
      await rendered.queryClient.invalidateQueries({ queryKey: dashboardDataKeys.members("channel-a"), exact: true });
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rendered.queryClient.getQueryState(dashboardDataKeys.members("channel-a"))?.status).toBe("error");
    expect(screen.getByText("Chat helper")).toBeVisible();
    await waitFor(() => expect(rendered.container.querySelector(".list-toolbar__status")?.textContent).toContain("Erneut versuchen"));
    const retry = screen.getByRole("button", { name: "Erneut versuchen" });
    expect(retry).toBeVisible();
    fireEvent.click(retry);

    expect(await screen.findByText("New helper")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("filters loaded members immediately and explains the protected last broadcaster", () => {
    renderMembers("manager", {
      members: [member({ userId: "broadcaster", login: "owner", displayName: "Channel owner", role: "broadcaster" }), member()],
      nextCursor: null,
      broadcasterCount: 1,
      viewerUserId: "viewer",
    });

    const protectedReason = membersTexts().lastBroadcaster;
    expect(screen.getByRole("img", { name: protectedReason })).toBeVisible();
    const search = screen.getByRole("textbox", { name: "Mitglieder suchen" });
    fireEvent.change(search, { target: { value: "helper" } });
    expect(screen.getByText("Chat helper")).toBeVisible();
    expect(screen.queryByText("Channel owner")).not.toBeInTheDocument();
    expect(document.querySelector(".list-toolbar__usage")).toHaveTextContent("1 von 2 Mitglieder");

    fireEvent.change(search, { target: { value: "owner" } });
    fireEvent.click(screen.getByText("Channel owner"));
    expect(screen.getByText(protectedReason)).toBeVisible();
  });
});
