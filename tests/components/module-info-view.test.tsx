import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENCY_TEMPLATE_VARIABLE } from "../../src/modules/currency/contracts";
import { ModuleInfoView } from "../../src/dashboard/ModuleInfoView";

describe("ModuleInfoView", () => {
  afterEach(cleanup);

  it("shows the module description, mandatory reason, and localized template variable details", () => {
    render(<ModuleInfoView
      description="Wandelt Beträge mit dem aktuellen Wechselkurs um."
      mandatoryReason="Die Währungsdatenquelle stellt den Umrechnungswert für Textbefehle bereit."
      language="de"
      templateVariableCatalog={[CURRENCY_TEMPLATE_VARIABLE]}
    />);

    expect(screen.getByText("Wandelt Beträge mit dem aktuellen Wechselkurs um.")).toBeDefined();
    expect(screen.getByText("Die Währungsdatenquelle stellt den Umrechnungswert für Textbefehle bereit.")).toBeDefined();
    expect(screen.getByText("Währungsumrechnung")).toBeDefined();
    expect(screen.getByText("currency.convert", { exact: true })).toBeDefined();
    expect(screen.getByText(CURRENCY_TEMPLATE_VARIABLE.picker.de.description)).toBeDefined();
    expect(screen.getByText("{currency.convert USD EUR}", { exact: true })).toBeDefined();
  });

  it("shows an empty catalog state without requiring any template variables", () => {
    render(<ModuleInfoView language="en" templateVariableCatalog={[]} />);

    expect(screen.getByText("This module does not provide template variables.")).toBeDefined();
  });
});
