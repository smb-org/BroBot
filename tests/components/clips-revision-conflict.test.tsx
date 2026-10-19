import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { moduleQueryKey } from "../../src/dashboard/data";
import { UiProvider } from "../../src/dashboard/ui";
import ClipsPanel from "../../src/modules/clips/panel";
import type { ClipsSettings } from "../../src/modules/clips/contracts";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const channelId = "channel-a";
const settingsUrl = `/api/channels/${channelId}/modules/clips/settings`;
const clipsUrl = `/api/channels/${channelId}/clips`;
const initialSettings: ClipsSettings = {
  commandMinimumRole: "vip",
  commandCooldownSeconds: 180,
  postClipLinkInChat: true,
  chatLinkTemplate: "Clip: {clip.title} {clip.url}",
  automaticClipsEnabled: true,
  automaticThresholdMultiplier: 3.5,
  automaticCooldownSeconds: 1200,
};

const pathOf = (input: RequestInfo | URL): string => new URL(
  input instanceof Request ? input.url : String(input),
  window.location.origin,
).pathname;

describe("clip settings revision conflicts", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps a dirty editor's baseline revision after another manager changes the template", async () => {
    let serverSettings = initialSettings;
    let serverRevision = 1;
    const patches: { revision: number; settings: ClipsSettings }[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = pathOf(input);
      if (path === settingsUrl && init?.method === "PATCH") {
        const bodyText = typeof init.body === "string" ? init.body : "";
        const body = JSON.parse(bodyText) as { revision: number; settings: ClipsSettings };
        patches.push(body);
        if (body.revision !== serverRevision) {
          return Promise.resolve(jsonResponse({ error: "revision_conflict" }, 409));
        }
        serverSettings = body.settings;
        serverRevision += 1;
        return Promise.resolve(jsonResponse({ settings: serverSettings, revision: serverRevision }));
      }
      if (path === settingsUrl) return Promise.resolve(jsonResponse({ settings: serverSettings, revision: serverRevision }));
      if (path === clipsUrl) return Promise.resolve(jsonResponse({ streamStartedAt: null, clips: [] }));
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);

    const managerA = renderWithQuery(<UiProvider><ClipsPanel channelId={channelId} language="en" /></UiProvider>);
    const managerB = renderWithQuery(<UiProvider><ClipsPanel channelId={channelId} language="en" /></UiProvider>);
    await screen.findAllByRole("heading", { name: "Chat command !clip", level: 2 });

    const cooldownInput = managerB.container.querySelector<HTMLInputElement>("#clips-command-cooldown");
    if (cooldownInput === null) throw new Error("The second manager's cooldown input was not rendered.");
    fireEvent.change(cooldownInput, {
      target: { value: "240" },
    });
    const templateInput = managerA.container.querySelector<HTMLInputElement>("#clips-chat-message");
    if (templateInput === null) throw new Error("The first manager's chat message input was not rendered.");
    fireEvent.change(templateInput, {
      target: { value: "Manager A's template: {clip.title} {clip.url}" },
    });
    fireEvent.click(within(managerA.container).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(serverRevision).toBe(2));

    await managerB.queryClient.invalidateQueries({
      queryKey: moduleQueryKey(channelId, "clips", "clips-settings"),
      exact: true,
    });
    fireEvent.click(within(managerB.container).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[0]).toMatchObject({ revision: 1, settings: { chatLinkTemplate: "Manager A's template: {clip.title} {clip.url}" } });
    expect(patches[1]).toMatchObject({
      revision: 1,
      settings: {
        commandCooldownSeconds: 240,
        chatLinkTemplate: initialSettings.chatLinkTemplate,
      },
    });
    expect(serverSettings.chatLinkTemplate).toBe("Manager A's template: {clip.title} {clip.url}");
    expect(await within(managerB.container).findByText(/Clip settings changed while you were editing/u)).toBeInTheDocument();
  });
});
