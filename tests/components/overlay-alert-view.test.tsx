import { cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import OverlayAlertView from "../../src/modules/overlay_alerts/overlay/view";

afterEach(cleanup);

describe("overlay alert element", () => {
  it("renders viewer supplied placeholder output as text, never markup", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const markup = renderToStaticMarkup(<OverlayAlertView config={{}} state={{
      revision: 1,
      serverNow: new Date(now).toISOString(),
      current: {
        operationId: "alert-xss",
        text: "<script>alert(1)</script>",
        durationSeconds: 5,
        volumePercent: 80,
        startedAt: new Date(now).toISOString(),
        endsAt: new Date(now + 5_000).toISOString(),
      },
      queue: [],
      operationIds: ["alert-xss"],
    }} now={now} />);

    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
  });
});
