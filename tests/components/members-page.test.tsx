import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MembersPage } from "../../src/dashboard/members";
import { membersTexts } from "../../src/dashboard/labels";
import { UiProvider } from "../../src/dashboard/ui";

const renderMembers = (ownRole: "broadcaster" | "manager" | "operator", error: string | null = null) => render(
  <UiProvider>
    <MembersPage
      channelId="channel-a"
      ownRole={ownRole}
      ownUserId="viewer"
      members={[]}
      broadcasterCount={1}
      nextCursor={null}
      loading={false}
      loadingNextPage={false}
      error={error}
      onReload={() => Promise.resolve()}
      onLoadNextPage={() => Promise.resolve()}
      onAuthenticationRequired={() => undefined}
    />
  </UiProvider>,
);

afterEach(() => {
  cleanup();
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
    renderMembers("manager", "The member list could not be loaded.");

    expect(document.querySelector(".content-section .form-error")).toBeNull();
  });

  it("filters loaded members immediately and explains the protected last broadcaster", () => {
    const members = [
      { userId: "broadcaster", login: "owner", displayName: "Channel owner", profileImageUrl: null, role: "broadcaster" as const, joinedAt: "2026-09-18T00:00:00.000Z" },
      { userId: "operator", login: "helper", displayName: "Chat helper", profileImageUrl: null, role: "operator" as const, joinedAt: "2026-09-18T00:00:00.000Z" },
    ];
    render(<UiProvider><MembersPage
      channelId="channel-a"
      ownRole="manager"
      ownUserId="viewer"
      members={members}
      broadcasterCount={1}
      nextCursor={null}
      loading={false}
      loadingNextPage={false}
      error={null}
      onReload={() => Promise.resolve()}
      onLoadNextPage={() => Promise.resolve()}
      onAuthenticationRequired={() => undefined}
    /></UiProvider>);

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
