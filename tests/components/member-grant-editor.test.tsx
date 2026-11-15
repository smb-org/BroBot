import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberGrantEditor } from "../../src/dashboard/member-grant-editor";
import { roleLabel } from "../../src/dashboard/labels";
import { UiProvider } from "../../src/dashboard/ui";

afterEach(cleanup);

describe("MemberGrantEditor", () => {
  it("keeps the selected manager role in the confirmation and submitted grant", async () => {
    const onGrant = vi.fn().mockResolvedValue(undefined);
    render(<UiProvider><MemberGrantEditor
      channelId="channel-a"
      roles={["manager", "operator"]}
      defaultRole="operator"
      texts={{
        ariaLabel: "Add member",
        title: "Add member",
        searchLabel: "Twitch login",
        searchHint: "Enter a login or choose a suggestion.",
        roleLabel: "Role",
        roleHint: "Choose the role for this member.",
        saveLabel: "Add member",
        confirmTitle: (name) => `Grant access to ${name}?`,
        confirmDescription: (name, role) => `${name} will be added as ${role}.`,
        confirmButton: "Grant access",
      }}
      loadSuggestions={() => Promise.resolve({
        users: [{ userId: "user-100", login: "streamhelper", displayName: "Stream Helper", profileImageUrl: null }],
        partial: false,
      })}
      onGrant={onGrant}
      errorText={() => "Grant failed."}
      onGranted={() => undefined}
      onAuthenticationRequired={() => undefined}
    /></UiProvider>);

    const input = screen.getByRole("combobox", { name: "Twitch login" });
    fireEvent.change(input, { target: { value: "streamhelper" } });
    fireEvent.click(await screen.findByRole("option", { name: /Stream Helper/u }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${roleLabel("manager")}\\.`, "u") }));
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));

    const confirmation = await screen.findByRole("dialog", { name: "Grant access to Stream Helper?" });
    expect(within(confirmation).getByText(`Stream Helper will be added as ${roleLabel("manager")}.`)).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Grant access" }));

    await waitFor(() => expect(onGrant).toHaveBeenCalledWith("user-100", "manager"));
  });
});
