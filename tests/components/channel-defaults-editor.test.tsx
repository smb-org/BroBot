import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { PanelChannelSettings } from "../../src/dashboard/api";
import { ChannelDefaultsEditor } from "../../src/dashboard/ChannelDefaultsEditor";
import { queryKeys } from "../../src/dashboard/data/keys";
import { UiProvider } from "../../src/dashboard/ui";
import { renderWithQuery } from "../query-test-utils";

afterEach(() => { cleanup(); });

describe("channel defaults editor", () => {
  it("keeps a chat-target draft when a remote refresh changes the time zone", async () => {
    const channelId = "channel-defaults-editor";
    const queryKey = queryKeys.channel(channelId, "settings");
    const initialSettings: PanelChannelSettings = {
      timeZone: "Europe/Berlin",
      revision: 1,
      location: null,
      locationRevision: 0,
      defaultChatTarget: "source_only",
      defaultChatTargetRevision: 1,
    };
    const { queryClient } = renderWithQuery(
      <UiProvider><ChannelDefaultsEditor channelId={channelId} role="manager" /></UiProvider>,
      undefined,
      { initialData: [{ queryKey, data: initialSettings }] },
    );

    fireEvent.click(screen.getByRole("button", { name: "Standard-Chat-Ziel" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Alle Chats/u, hidden: true }));
    const save = await screen.findByRole("button", { name: "Speichern" });
    await waitFor(() => { expect(save).toBeEnabled(); });

    queryClient.setQueryData<PanelChannelSettings>(queryKey, {
      ...initialSettings,
      timeZone: "UTC",
      revision: 2,
    });

    expect(screen.getByRole("button", { name: "Standard-Chat-Ziel" })).toHaveTextContent("Alle Chats");
    expect(save).toBeEnabled();
  });

  it("shows operator settings as one read-only properties list without disabled form controls", async () => {
    const channelId = "channel-defaults-operator";
    const queryKey = queryKeys.channel(channelId, "settings");
    const initialSettings: PanelChannelSettings = {
      timeZone: "Europe/Berlin",
      revision: 1,
      location: null,
      locationRevision: 0,
      defaultChatTarget: "source_only",
      defaultChatTargetRevision: 1,
    };
    const { container } = renderWithQuery(
      <UiProvider><ChannelDefaultsEditor channelId={channelId} role="operator" /></UiProvider>,
      undefined,
      { initialData: [{ queryKey, data: initialSettings }] },
    );

    expect(await screen.findByText("Nur Broadcaster und Verwalter dürfen diese Einstellung ändern.")).toBeVisible();
    expect(screen.getAllByText("Nur Broadcaster und Verwalter dürfen diese Einstellung ändern.")).toHaveLength(1);
    expect(screen.queryByText("Europe/Berlin")).not.toBeInTheDocument();
    expect(screen.getByText("Nur unser Chat")).toBeVisible();
    expect(container.querySelectorAll("input, [role=combobox]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verwerfen" })).not.toBeInTheDocument();
  });
});
