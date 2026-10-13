import { afterEach, describe, expect, it, vi } from "vitest";

import { loadFaqPanel } from "../../src/modules/faq/panel/service";
import { loadTimersPanel } from "../../src/modules/timers/panel/service";

const pickerVariables = [
  { name: "currency.convert", sample: "11,50 €", parameters: "currency_pair", parameterDefault: "USD EUR" },
  { name: "api.sunset", sample: "18:42" },
  { name: "pick", sample: "First", parameters: "choices", contexts: ["event", "chat_command"], parameterDefault: "first|second" },
  { name: "user", sample: "Viewer", contexts: ["chat_command"] },
  { name: "channel", sample: "samplechannel", contexts: ["chat_command"] },
  { name: "viewers", sample: "42", contexts: ["chat_command", "event", "system"] },
  { name: "votekick.duration", sample: "2 min", contexts: ["event"], availableInEventTemplates: false },
];

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { "Content-Type": "application/json" },
});

const stubPanelFetch = (): void => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "https://brobot.example");
    if (url.pathname.endsWith("/template-variables")) return Promise.resolve(response({ variables: pickerVariables }));
    if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(response({ sources: [] }));
    if (url.pathname.endsWith("/timers")) return Promise.resolve(response({ timers: [] }));
    return Promise.resolve(response({ entries: [] }));
  }));
};

describe("timer and FAQ panel variable loading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads namespaced API variables as direct timer picker options", async () => {
    stubPanelFetch();

    const panel = await loadTimersPanel("channel-a");

    expect(panel.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "currency.convert", parameters: "currency_pair", parameter: { value: "USD EUR" } }),
      expect.objectContaining({ name: "api.sunset", sample: "18:42" }),
    ]));
  });

  it("loads namespaced API variables as direct FAQ picker options", async () => {
    stubPanelFetch();

    const panel = await loadFaqPanel("channel-a");

    expect(panel.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "currency.convert", parameters: "currency_pair", parameter: { value: "USD EUR" } }),
      expect.objectContaining({ name: "api.sunset", sample: "18:42" }),
    ]));
  });

  it.each([
    ["timer", loadTimersPanel],
    ["FAQ", loadFaqPanel],
  ] as const)("keeps choices defaults and filters chat-only variables in the %s picker", async (_label, loadPanel) => {
    stubPanelFetch();

    const panel = await loadPanel("channel-a");

    expect(panel.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "pick", parameters: "choices", parameter: { value: "first|second" } }),
    ]));
    expect(panel.variables.some((variable) => variable.name === "user")).toBe(false);
    expect(panel.variables.some((variable) => variable.name === "channel")).toBe(false);
    expect(panel.variables.some((variable) => variable.name === "votekick.duration")).toBe(false);
  });

  it.each([
    ["timer", loadTimersPanel],
    ["FAQ", loadFaqPanel],
  ] as const)("offers host {viewers} in the %s event picker", async (_label, loadPanel) => {
    stubPanelFetch();

    const panel = await loadPanel("channel-a");

    expect(panel.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "viewers", sample: "42" }),
    ]));
  });
});
