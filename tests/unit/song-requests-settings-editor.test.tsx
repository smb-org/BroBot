import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, SettingsPage } from "../../src/dashboard/ui";
import { songRequestsSettingsTexts } from "../../src/modules/song_requests/panel/settings-locale";
import { songRequestsSettingsSchema } from "../../src/modules/song_requests/contracts";
import { SONG_REQUEST_TEMPLATE_VARIABLES } from "../../src/modules/song_requests/contracts/template-variables";
import { songRequestsModule } from "../../src/modules/song_requests";
import definition from "../../src/modules/song_requests/panel/settings-editor";

describe("song request shared settings editor", () => {
  afterEach(cleanup);

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

  it("declares the live panel first and binds settings to a second bilingual navigation entry", () => {
    const entries = songRequestsModule.navigationEntries ?? [];

    expect(entries.map(({ id }) => id)).toEqual(["requests", "settings"]);
    expect(entries.map(({ label }) => label.en)).toEqual(["Song requests", "Song request settings"]);
    expect(entries.map(({ label }) => label.de)).toEqual(["Song-Wünsche", "Song-Wunsch-Einstellungen"]);
    expect(entries.every(({ label }) => label.de !== label.en)).toBe(true);
    expect(entries.map(({ description }) => description?.en)).toEqual([
      "Connects Spotify and shows song requests and vote outcomes.",
      "Configure payment, admission rules, and song request alerts.",
    ]);
    expect(entries.every(({ description }) => description?.de !== description?.en)).toBe(true);
    expect(songRequestsModule.settingsEditorPageId).toBe("settings");
  });

  it("disables bot points and explains why when the points module is off", () => {
    const catalog = definition.locales.en;
    const settings = songRequestsSettingsSchema.parse({ paymentMode: "bot_points" });
    render(<SettingsEditor
      spec={definition.spec}
      sectionId="admission"
      settings={settings}
      onChange={() => undefined}
      texts={catalog}
      templateMessages={catalog.templateMessages}
      customContext={{ language: "en", enabledModuleIds: [] }}
    />);

    expect(screen.getByRole("button", { name: /Bot points/u })).toBeDisabled();
    expect(screen.getByText(songRequestsSettingsTexts.en.pointsUnavailable)).toBeVisible();
  });

  it("leaves bot points available without the unavailable hint when the points module is on", () => {
    const catalog = definition.locales.en;
    const settings = songRequestsSettingsSchema.parse({ paymentMode: "bot_points" });
    render(<SettingsEditor
      spec={definition.spec}
      sectionId="admission"
      settings={settings}
      onChange={() => undefined}
      texts={catalog}
      templateMessages={catalog.templateMessages}
      customContext={{ language: "en", enabledModuleIds: ["points"] }}
    />);

    expect(screen.getByRole("button", { name: "Bot points" })).toBeEnabled();
    expect(screen.queryByText(songRequestsSettingsTexts.en.pointsUnavailable)).not.toBeInTheDocument();
  });

  it("renders a single visible label for each enabled-value rule", () => {
    const catalog = definition.locales.en;
    const settings = songRequestsSettingsSchema.parse({});
    render(<SettingsEditor
      spec={definition.spec}
      sectionId="rules"
      settings={settings}
      onChange={() => undefined}
      texts={catalog}
      templateMessages={catalog.templateMessages}
      customContext={{ language: "en" }}
    />);

    for (const label of [
      "Track cooldown",
      "Per-person cooldown",
      "Maximum open requests per person",
      "Requests per stream or offline round",
      "Maximum open requests in the channel",
      "Maximum open requests per artist",
      "Maximum track length",
    ]) {
      expect(screen.getAllByText(label, { exact: true })).toHaveLength(1);
      expect(screen.getByRole("switch", { name: label })).toBeInTheDocument();
      expect(screen.getByRole("spinbutton", { name: label })).toBeInTheDocument();
    }
  });
});
