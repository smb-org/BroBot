import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { z } from "zod";

import { PanelApiError } from "../../src/contracts/panel-error";
import { UiProvider } from "../../src/dashboard/ui";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import { MODULES } from "../../src/modules/registry";
import type { BotModule } from "../../src/modules/contract";
import type { ChannelPointsRedemption, ChannelPointsReward } from "../../src/modules/channel_points/contracts";
import ChannelPointsPanel from "../../src/modules/channel_points/panel";
import { clickSelectOption, renderWithQuery } from "../query-test-utils";

const mocks = vi.hoisted(() => ({
  loadState: vi.fn(),
  loadHistory: vi.fn(),
  loadModuleAvailability: vi.fn(),
  reconcile: vi.fn(),
  createReward: vi.fn(),
  updateReward: vi.fn(),
  deleteReward: vi.fn(),
  recreateReward: vi.fn(),
}));

vi.mock("../../src/modules/channel_points/panel/service", () => ({
  loadChannelPointsState: mocks.loadState,
  loadChannelPointsRedemptions: mocks.loadHistory,
  loadChannelPointsModuleAvailability: mocks.loadModuleAvailability,
  reconcileChannelPoints: mocks.reconcile,
  createChannelPointsReward: mocks.createReward,
  updateChannelPointsReward: mocks.updateReward,
  deleteChannelPointsReward: mocks.deleteReward,
  recreateChannelPointsReward: mocks.recreateReward,
}));

const at = "2030-01-01T12:00:00.000Z";
const reward = (overrides: Partial<ChannelPointsReward> = {}): ChannelPointsReward => ({
  id: "reward-local",
  twitchRewardId: "reward-twitch",
  title: "Chat-Wunsch",
  prompt: null,
  cost: 100,
  backgroundColor: null,
  isUserInputRequired: false,
  globalCooldownSeconds: null,
  maxPerStream: null,
  maxPerUserPerStream: null,
  actionModuleId: "channel_points",
  actionId: "chat-message",
  actionConfig: { message: "Danke, {user}!" },
  mode: "auto",
  enabled: true,
  twitchState: "active",
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const redemption = (overrides: Partial<ChannelPointsRedemption> = {}): ChannelPointsRedemption => ({
  redemptionId: "redemption-1",
  rewardId: "reward-local",
  twitchRewardId: "reward-twitch",
  rewardTitle: "Chat-Wunsch",
  userId: "viewer-1",
  userLogin: "viewer_one",
  userName: "Viewer One",
  userInput: "Hallo",
  redeemedAt: at,
  status: "fulfilled",
  pendingTwitchStatus: null,
  outcomeReason: null,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const scopes = ["channel:read:redemptions", "channel:manage:redemptions"];
const state = (overrides: Partial<{
  rewards: ChannelPointsReward[];
  moduleEnabled: boolean;
  connection: { connected: boolean; scopes: string[]; missingScopes: string[] };
}> = {}) => ({
  rewards: overrides.rewards ?? [],
  moduleEnabled: overrides.moduleEnabled ?? true,
  connection: overrides.connection ?? { connected: true, scopes, missingScopes: [] },
});

const moduleAvailability = (disabled: readonly string[] = []) => [
  ...MODULES.map(({ id }) => ({ id, enabled: !disabled.includes(id) })),
  { id: "test_action_provider", enabled: !disabled.includes("test_action_provider") },
];

const fakeActionModule = {
  id: "test_action_provider",
  channelPointsActions: [{
    id: "viewer-text",
    name: { de: "Text-Aktion", en: "Text action" },
    configSchema: z.object({}),
    requiresUserInput: true,
    execute: () => Promise.resolve("fulfilled" as const),
  }],
} as unknown as BotModule;
const moduleRegistry = MODULES as BotModule[];
const registryLength = moduleRegistry.length;
moduleRegistry.push(fakeActionModule);

afterAll(() => { moduleRegistry.splice(registryLength); });
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

beforeEach(() => {
  mocks.loadState.mockResolvedValue(state());
  mocks.loadHistory.mockResolvedValue({ items: [], cursor: null });
  mocks.loadModuleAvailability.mockResolvedValue(moduleAvailability());
  mocks.reconcile.mockResolvedValue({ ok: true });
  mocks.createReward.mockResolvedValue(reward());
  mocks.updateReward.mockImplementation((_channelId: string, _id: string, input: Partial<ChannelPointsReward>) => Promise.resolve(reward(input)));
  mocks.deleteReward.mockResolvedValue(undefined);
  mocks.recreateReward.mockResolvedValue(reward());
});

const mount = (options: { canManage?: boolean; canOperate?: boolean; language?: "de" | "en" } = {}) => renderWithQuery(
  <UiProvider><ChannelPointsPanel channelId="channel-demo" language={options.language ?? "de"}
    canManage={options.canManage ?? true} canOperate={options.canOperate ?? true}
    channelPointsActions={MODULES.flatMap(({ id, channelPointsActions }) => (channelPointsActions ?? []).map((definition) => ({ moduleId: id, definition })))} /></UiProvider>,
);

const openNewReward = async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Neu" }));
  return screen.findByRole("dialog", { name: "Neue Belohnung" });
};

describe("channel points panel", () => {
  it("renders active, creating, deleted, and module-disabled Twitch states", async () => {
    mocks.loadState.mockResolvedValue(state({ rewards: [
      reward({ id: "reward-active", title: "Aktiv" }),
      reward({ id: "reward-creating", title: "Wird angelegt", twitchState: "creating" }),
      reward({ id: "reward-deleted", title: "Gelöscht", twitchState: "deleted_on_twitch" }),
    ] }));
    mount();
    expect(await screen.findByText("Auf Twitch aktiv")).toBeVisible();
    expect(screen.getByText("Wird angelegt")).toBeVisible();
    expect(screen.getByText("Auf Twitch gelöscht")).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Gelöscht aktiv" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Gelöscht auf Twitch neu anlegen" }));
    await waitFor(() => expect(mocks.recreateReward).toHaveBeenCalled());

    cleanup();
    mocks.loadState.mockResolvedValue(state({ moduleEnabled: false, rewards: [reward({ title: "Modul aus" })] }));
    mount();
    expect(await screen.findByText("Durch Modul deaktiviert")).toBeVisible();
  });

  it("hides reward-management controls from operators while keeping reconcile available", async () => {
    mocks.loadState.mockResolvedValue(state({ rewards: [reward()] }));
    mount({ canManage: false, canOperate: true });
    expect(await screen.findByText("Chat-Wunsch")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Neu" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Chat-Wunsch aktiv" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Weitere Aktionen für Chat-Wunsch/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Von Twitch aktualisieren" })).toBeEnabled();
  });

  it("optimistically updates the active switch once and rolls back on failure", async () => {
    let rejectUpdate: ((error: unknown) => void) | undefined;
    mocks.loadState.mockResolvedValue(state({ rewards: [reward()] }));
    mocks.updateReward.mockImplementation(() => new Promise((_resolve, reject) => { rejectUpdate = reject; }));
    mount();
    const activeSwitch = await screen.findByRole("switch", { name: "Chat-Wunsch aktiv" });
    expect(activeSwitch).toBeChecked();
    fireEvent.click(activeSwitch);
    await waitFor(() => expect(activeSwitch).not.toBeChecked());
    rejectUpdate?.(new PanelApiError(502, "channel_points_network", { error: "channel_points_network" }));
    await waitFor(() => expect(activeSwitch).toBeChecked());
    expect(mocks.updateReward).toHaveBeenCalledTimes(1);
    expect(mocks.updateReward.mock.calls[0]?.[2]).toMatchObject({ enabled: false });
  });

  it("shows Twitch limits, labels, units, and counters in the explicit editor", async () => {
    const dialog = await openNewReward();
    expect(within(dialog).getByText("0 / 45")).toBeVisible();
    expect(within(dialog).getByText("0 / 200")).toBeVisible();
    expect(within(dialog).getByRole("spinbutton", { name: "Kosten" })).toHaveAttribute("min", "1");
    fireEvent.click(within(dialog).getByRole("switch", { name: "Maximal pro Stream" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Maximal pro Person und Stream" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Cooldown pro Belohnung" }));
    expect(within(dialog).getByRole("spinbutton", { name: "Cooldown pro Belohnung" })).toBeInTheDocument();
    expect(within(dialog).getByText("s", { selector: ".unit-input__unit" })).toBeVisible();
    expect(within(dialog).getByText("× pro Stream", { selector: ".unit-input__unit" })).toBeInTheDocument();
    expect(within(dialog).getByText("× pro Person", { selector: ".unit-input__unit" })).toBeInTheDocument();
  });

  it("closes an untouched new reward without asking for confirmation", async () => {
    const dialog = await openNewReward();
    fireEvent.click(within(dialog).getByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Neue Belohnung" })).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: "Änderungen verwerfen?" })).not.toBeInTheDocument();
  });

  it("confirms close and Escape for dirty rewards, preserving edits on continue and discarding on confirm", async () => {
    const dialog = await openNewReward();
    const title = within(dialog).getByLabelText("Titel");
    fireEvent.change(title, { target: { value: "Entwurf behalten" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Schließen" }));
    let confirmation = await screen.findByRole("dialog", { name: "Änderungen verwerfen?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Weiter bearbeiten" }));
    expect(within(dialog).getByLabelText("Titel")).toHaveValue("Entwurf behalten");

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    confirmation = await screen.findByRole("dialog", { name: "Änderungen verwerfen?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Verwerfen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Neue Belohnung" })).not.toBeInTheDocument());
  });

  it("disables reward fields and action settings during save, then closes with the saved reward", async () => {
    let resolveSave: (saved: ChannelPointsReward) => void = () => { throw new Error("Save has not started"); };
    mocks.createReward.mockImplementation(() => new Promise<ChannelPointsReward>((resolve) => { resolveSave = resolve; }));
    const dialog = await openNewReward();
    const title = within(dialog).getByLabelText("Titel");
    fireEvent.change(title, { target: { value: "Gespeicherter Entwurf" } });
    const chatMessage = await within(dialog).findByLabelText("Chat-Nachricht");
    const insertPlaceholder = within(dialog).getByRole("button", { name: "Platzhalter {user} einfügen" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(title).toBeDisabled());
    expect(chatMessage).toBeDisabled();
    expect(insertPlaceholder).toBeDisabled();
    expect(mocks.createReward).toHaveBeenCalledWith("channel-demo", expect.objectContaining({ title: "Gespeicherter Entwurf" }));

    mocks.loadState.mockResolvedValue(state({ rewards: [reward({ title: "Gespeicherter Entwurf" })] }));
    resolveSave(reward({ title: "Gespeicherter Entwurf" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Neue Belohnung" })).not.toBeInTheDocument());
    expect(await screen.findByText("Gespeicherter Entwurf")).toBeVisible();
  });

  it("blocks the confirmation's Save while the editor's own save is pending", async () => {
    mocks.createReward.mockImplementation(() => new Promise<ChannelPointsReward>(() => undefined));
    const dialog = await openNewReward();
    fireEvent.change(within(dialog).getByLabelText("Titel"), { target: { value: "Langsamer Entwurf" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mocks.createReward).toHaveBeenCalledTimes(1));

    runDashboardNavigationGuards(() => undefined, () => undefined);
    const confirmation = await screen.findByRole("dialog", { name: "Änderungen verwerfen?" });
    const save = within(confirmation).getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(mocks.createReward).toHaveBeenCalledTimes(1);
  });

  it("keeps a disabled action provider visible with its disabled reason", async () => {
    mocks.loadModuleAvailability.mockResolvedValue(moduleAvailability(["channel_points"]));
    const dialog = await openNewReward();
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Aktion" }));
    const disabledOption = await screen.findByRole("option", { name: /Chat-Nachricht.*Modul für diese Aktion ist ausgeschaltet/u });
    expect(disabledOption).toHaveAttribute("aria-disabled", "true");
  });

  it("forces and locks viewer input when the selected action requires it", async () => {
    const dialog = await openNewReward();
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Aktion" }));
    clickSelectOption(await screen.findByRole("option", { name: "Text-Aktion", hidden: true }));
    const inputSwitch = within(dialog).getByRole("switch", { name: "Zuschauereingabe erforderlich" });
    await waitFor(() => expect(inputSwitch).toBeChecked());
    expect(inputSwitch).toBeDisabled();
    expect(within(dialog).getByText("Diese Aktion benötigt eine Zuschauereingabe.")).toBeVisible();
  });

  it("inserts a chat placeholder chip at the saved cursor position", async () => {
    const dialog = await openNewReward();
    const template = await within(dialog).findByLabelText("Chat-Nachricht");
    fireEvent.change(template, { target: { value: "Hi!" } });
    Object.defineProperty(template, "selectionStart", { configurable: true, value: 3 });
    Object.defineProperty(template, "selectionEnd", { configurable: true, value: 3 });
    fireEvent.select(template);
    fireEvent.mouseDown(within(dialog).getByRole("button", { name: "Platzhalter {user} einfügen" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Platzhalter {user} einfügen" }));
    expect(template).toHaveValue("Hi!{user}");
    expect(within(dialog).getByText("9 / 500")).toBeVisible();
  });

  it("maps duplicate-title server errors to the title field", async () => {
    mocks.createReward.mockRejectedValue(new PanelApiError(409, "channel_points_duplicate_title", { error: "channel_points_duplicate_title" }));
    const dialog = await openNewReward();
    fireEvent.change(within(dialog).getByLabelText("Titel"), { target: { value: "Doppelter Titel" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByText("Dieser Titel wird bereits verwendet.")).toBeVisible();
  });

  it("maps action config errors to the action editor field", async () => {
    mocks.createReward.mockRejectedValue(new PanelApiError(422, "channel_points_action_config_invalid", { error: "channel_points_action_config_invalid" }));
    const dialog = await openNewReward();
    fireEvent.change(within(dialog).getByLabelText("Titel"), { target: { value: "Konfiguration prüfen" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByText("Prüfe die Einstellungen dieser Aktion.")).toBeVisible();
  });

  it("maps Twitch's custom reward limit to clear server copy", async () => {
    mocks.createReward.mockRejectedValue(new PanelApiError(409, "channel_points_reward_limit", { error: "channel_points_reward_limit" }));
    const dialog = await openNewReward();
    fireEvent.change(within(dialog).getByLabelText("Titel"), { target: { value: "Limit erreicht" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByText("Twitch erlaubt höchstens 50 eigene Belohnungen pro Kanal.")).toBeVisible();
  });

  it("localizes missing scopes", async () => {
    mocks.loadState.mockResolvedValue(state({ connection: { connected: true, scopes: [], missingScopes: ["channel:read:redemptions"] } }));
    mount();
    expect(await screen.findByText(/Fehlende Twitch-Berechtigung/u)).toBeVisible();
  });

  it("renders fulfilled, refunded, open, and orphaned redemption outcomes", async () => {
    mocks.loadHistory.mockResolvedValue({ items: [
      redemption({ redemptionId: "fulfilled", status: "fulfilled" }),
      redemption({ redemptionId: "refunded", status: "refunded", outcomeReason: { de: "Aktion fehlgeschlagen", en: "Action failed" } }),
      redemption({ redemptionId: "queued", status: "queued", userInput: "A very long input that is truncated in the row" }),
      redemption({ redemptionId: "orphaned", status: "orphaned", outcomeReason: { de: "Belohnung gelöscht", en: "Reward deleted" } }),
    ], cursor: null });
    mount();
    const history = await screen.findByRole("region", { name: "Verlauf" });
    expect(await within(history).findByText("Erledigt")).toBeVisible();
    expect(await within(history).findByText("Erstattet · Aktion fehlgeschlagen")).toBeVisible();
    expect(await within(history).findByText("Offen")).toBeVisible();
    expect(await within(history).findByText("Verwaist · Belohnung gelöscht")).toBeVisible();
    expect(await within(history).findAllByText("Viewer One")).toHaveLength(4);
  });
});
