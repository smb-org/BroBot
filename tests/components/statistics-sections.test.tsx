import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatisticsSections } from "../../src/dashboard/StatisticsSections";
import type { ModuleRegisteredStatisticsSection } from "../../src/modules/contract";

afterEach(cleanup);

describe("shared statistics section renderer", () => {
  it("renders sections contributed by enabled modules only", async () => {
    const sections: ModuleRegisteredStatisticsSection[] = [{
      id: "visible",
      moduleId: "song_requests",
      title: { de: "Sichtbare Statistiken", en: "Visible statistics" },
      load: () => Promise.resolve({ default: () => <p>visible module statistics</p> }),
    }, {
      id: "hidden",
      moduleId: "votekick",
      title: { de: "Verborgene Statistiken", en: "Hidden statistics" },
      load: () => Promise.resolve({ default: () => <p>disabled module statistics</p> }),
    }];

    render(<StatisticsSections
      sections={sections}
      enabledModuleIds={["song_requests"]}
      channelId="channel-statistics-sections"
      language="en"
      scope={{ kind: "total" }}
    />);

    expect(await screen.findByText("visible module statistics")).toBeInTheDocument();
    expect(screen.queryByText("disabled module statistics")).not.toBeInTheDocument();
    expect(screen.getByText("Visible statistics")).toBeInTheDocument();
  });
});
