import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import AdNowAction from "../../src/modules/ads/panel/immediate-actions";
import ShoutoutAction from "../../src/modules/raid/panel/immediate-actions";
import ClipAction from "../../src/modules/clips/panel/immediate-actions";

afterEach(cleanup);

describe("immediate action result slots", () => {
  it("keeps one result line mounted for ads, raids, and clips", () => {
    render(<UiProvider>
      <AdNowAction channelId="channel-a" availabilityReason={null} />
      <ShoutoutAction channelId="channel-a" availabilityReason={null} />
      <ClipAction channelId="channel-a" availabilityReason={null} />
    </UiProvider>);

    expect(screen.getAllByTestId("immediate-action-result-slot")).toHaveLength(3);
  });
});
