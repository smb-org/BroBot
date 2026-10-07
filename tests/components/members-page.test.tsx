import { cleanup, render, screen } from "@testing-library/react";
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
    const reason = document.getElementById("members-create-reason");
    expect(grantButton).toBeInTheDocument();
    expect(grantButton).toHaveProperty("disabled", disabled);
    expect(reason).toBeInTheDocument();
    if (disabled) {
      expect(grantButton).toHaveAttribute("aria-describedby", "members-create-reason");
      expect(reason).toHaveTextContent(membersTexts().managementLocked);
    } else {
      expect(reason).toBeEmptyDOMElement();
    }
  });

  it("keeps member-list errors out of the list flow", () => {
    renderMembers("manager", "The member list could not be loaded.");

    expect(document.querySelector(".content-section .form-error")).toBeNull();
  });
});
