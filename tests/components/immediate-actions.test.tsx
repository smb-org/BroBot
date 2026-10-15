import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ImmediateActions } from "../../src/dashboard/ImmediateActions";
import { UiProvider } from "../../src/dashboard/ui";

afterEach(() => { cleanup(); });

describe("cockpit action role mirror", () => {
  it("locks manager actions for operators while keeping operator actions available", () => {
    render(
      <UiProvider>
        <ImmediateActions
          channelId="channel-a"
          streamState="online"
          role="operator"
          modules={[{ id: "ads", enabled: true }, { id: "clips", enabled: true }]}
        />
      </UiProvider>,
    );

    const adAction = screen.getByRole("button", { name: /Werbung starten|Start ad break/u });
    const clipAction = screen.getByRole("button", { name: /Clip erstellen|Create clip/u });
    expect(adAction).toBeDisabled();
    expect(adAction).toHaveAttribute("aria-haspopup", "dialog");
    expect(clipAction).toBeEnabled();
    expect(clipAction).not.toHaveAttribute("aria-haspopup");
    expect(screen.getByText(/Nur Verwalter und Broadcaster dürfen diese Aktion ausführen\.|Only managers and broadcasters may run this action\./u)).toBeVisible();
  });
});
