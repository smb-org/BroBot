import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsEditor, SettingsPage } from "../../src/dashboard/ui";
import { songRequestsSettingsSchema } from "../../src/modules/song_requests/contracts";
import { SONG_REQUEST_TEMPLATE_VARIABLES } from "../../src/modules/song_requests/contracts/template-variables";
import definition from "../../src/modules/song_requests/panel/settings-editor";

describe("song request shared settings editor", () => {
  it("renders both configured columns with admission, rules, skip vote, alert, overlay, and messages", () => {
    const catalog = definition.locales.en;
    const settings = songRequestsSettingsSchema.parse({});
    const templateVariables = Object.fromEntries(["queuedText", "waitingText", "requestAlertText"].map((key) => {
      const typeSample = catalog.fields[key]?.variables?.find(({ name }) => name === "song.type")?.sample;
      return [key, SONG_REQUEST_TEMPLATE_VARIABLES.map((variable) => ({
        name: variable.name,
        label: variable.picker?.en.label ?? variable.name,
        description: variable.picker?.en.description ?? variable.name,
        sample: variable.name === "song.type" ? typeSample ?? variable.sample : variable.sample,
      }))];
    }));
    const columns = (definition.pageColumns ?? []).map((sectionIds, index) => <div className="settings-page__column-stack" key={index}>
      {sectionIds.map((sectionId) => <SettingsEditor
        key={sectionId}
        spec={definition.spec}
        sectionId={sectionId}
        settings={settings}
        onChange={() => undefined}
        texts={catalog}
        templateMessages={catalog.templateMessages}
        {...(catalog.messageEnabledLabel === undefined ? {} : { messageEnabledLabel: catalog.messageEnabledLabel })}
        customContext={{ language: "en" }}
        variables={templateVariables}
        idPrefix={"song-requests-" + sectionId}
      />)}
    </div>);

    const { container } = render(<SettingsPage title="Song requests" columns={columns} />);

    expect(definition.layout).toBe("columns");
    expect(definition.savePosition).toBe("page-header");
    expect(definition.showTitle).toBe(false);
    expect(container.querySelectorAll(".settings-page__column")).toHaveLength(2);
    for (const title of ["Admission", "Admission rules", "Skip vote", "Song request alert", "Overlay", "Messages"]) {
      expect(screen.getByText(title, { selector: "h2, h3, h4, legend" })).toBeInTheDocument();
    }
    expect(screen.getByRole("textbox", { name: "Queued result" })).toHaveValue("“{song.track}” was queued in Spotify. Position {song.position}.");
    expect(screen.getByRole("textbox", { name: "Waiting for approval" })).toHaveValue("“{song.track}” is waiting for moderator approval.");
    expect(screen.getByText("“Nightwish – Sleeping Sun (Oceanborn)” was queued in Spotify. Position 1.")).toBeInTheDocument();
    expect(screen.getByText("Maple Viewer · Free request: Nightwish – Sleeping Sun (Oceanborn)")).toBeInTheDocument();
  });
});
