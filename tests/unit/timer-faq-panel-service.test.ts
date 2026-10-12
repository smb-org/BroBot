import { afterEach, describe, expect, it, vi } from "vitest";

import { loadFaqPanel } from "../../src/modules/faq/panel/service";
import { loadTimersPanel } from "../../src/modules/timers/panel/service";

const parameterizedVariables = [
  { name: "currency.convert", sample: "11,50 €", parameters: "currency_pair", parameterDefault: "USD EUR" },
  { name: "api_source.value", sample: "18:42", parameters: "api_source_name", parameterDefault: "sunset" },
];

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { "Content-Type": "application/json" },
});

const stubPanelFetch = (): void => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "https://brobot.example");
    if (url.pathname.endsWith("/template-variables")) return Promise.resolve(response({ variables: parameterizedVariables }));
    if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(response({ sources: [] }));
    if (url.pathname.endsWith("/timers")) return Promise.resolve(response({ timers: [] }));
    return Promise.resolve(response({ entries: [] }));
  }));
};

describe("timer and FAQ panel variable loading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves parameter declarations and defaults in timer picker options", async () => {
    stubPanelFetch();

    const panel = await loadTimersPanel("channel-a");

    expect(panel.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "currency.convert", parameters: "currency_pair", parameter: { value: "USD EUR" } }),
      expect.objectContaining({ name: "api_source.value", parameters: "api_source_name", parameter: { value: "sunset" } }),
    ]));
  });

  it("preserves parameter declarations and defaults in FAQ picker options", async () => {
    stubPanelFetch();

    const panel = await loadFaqPanel("channel-a");

    expect(panel.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "currency.convert", parameters: "currency_pair", parameter: { value: "USD EUR" } }),
      expect.objectContaining({ name: "api_source.value", parameters: "api_source_name", parameter: { value: "sunset" } }),
    ]));
  });
});
