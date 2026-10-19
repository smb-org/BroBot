import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { moduleQueryKey } from "../../src/dashboard/data/module-query";
import { PanelApiError } from "../../src/contracts/panel-error";
import { UiProvider } from "../../src/dashboard/ui";
import PointsPanel from "../../src/modules/points/panel";
import { renderWithQuery } from "../query-test-utils";

const mocks = vi.hoisted(() => ({
  adjustPoints: vi.fn(),
  loadPointsAccount: vi.fn(),
  loadPointsAccounts: vi.fn(),
  loadPointsHistory: vi.fn(),
  loadPointsRank: vi.fn(),
  loadPointsSettings: vi.fn(),
  loadPointsSummary: vi.fn(),
  savePointsSettings: vi.fn(),
}));

vi.mock("../../src/modules/points/panel/service", () => mocks);

const settings = {
  currencyName: "Points",
  startBonus: 100,
  activityAmount: 5,
  windowMinutes: 10,
  dailyCap: 150,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

beforeEach(() => {
  mocks.adjustPoints.mockResolvedValue({ balance: 100, auditPending: false });
  mocks.loadPointsAccount.mockResolvedValue({ accountId: "viewer_demo", login: "pixelpilz", balance: 100 });
  mocks.loadPointsAccounts.mockResolvedValue({ rows: [{ accountId: "viewer_demo", login: "pixelpilz", balance: 100, monthNet: 0 }] });
  mocks.loadPointsHistory.mockResolvedValue({ rows: [] });
  mocks.loadPointsRank.mockResolvedValue({ rank: 1, net: 0 });
  mocks.loadPointsSettings.mockResolvedValue({ settings, revision: 1 });
  mocks.loadPointsSummary.mockResolvedValue({ circulation: 100, jackpots: {}, inRounds: 0, accounts: 1, month: "2026-10" });
  mocks.savePointsSettings.mockResolvedValue({ settings, revision: 2 });
});

describe("points panel", () => {
  it("keeps a dirty settings draft and offers the server revision reload (protects=settings drafts stay based on their original revision after a refetch; fails_when=the server value replaces the draft or save remains available without a reload choice; no_claim=the server revision is advanced through the dashboard query cache)", async () => {
    const view = renderWithQuery(<UiProvider><PointsPanel channelId="kanal_demo" language="en" canManage /></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    const settingsPanel = screen.getByLabelText("Points settings");
    const startBonus = within(settingsPanel).getByLabelText("Start balance");
    const saveBar = settingsPanel.querySelector(".ui-save-bar");
    expect(saveBar).not.toBeNull();
    await waitFor(() => expect(startBonus).toBeEnabled());
    fireEvent.change(startBonus, { target: { value: "125" } });
    expect(startBonus).toHaveValue("125");
    expect(settingsPanel.querySelector(".ui-save-bar")).toBe(saveBar);
    mocks.loadPointsSettings.mockResolvedValueOnce({ settings: { ...settings, startBonus: 200 }, revision: 2 });
    await act(async () => {
      await view.queryClient.refetchQueries({ queryKey: moduleQueryKey("kanal_demo", "points", "settings"), exact: true });
    });
    view.rerender(<UiProvider><PointsPanel channelId="kanal_demo" language="en" canManage /></UiProvider>);

    expect(mocks.loadPointsSettings).toHaveBeenCalledTimes(2);
    expect(startBonus).toHaveValue("125");
    expect(within(settingsPanel).getByRole("status")).toHaveTextContent("changed in another session");
    expect(within(settingsPanel).getByRole("button", { name: "Load server version" })).toBeEnabled();
    expect(within(settingsPanel).queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.click(within(settingsPanel).getByRole("button", { name: "Load server version" }));
    expect(startBonus).toHaveValue("200");
    expect(settingsPanel.querySelector(".ui-save-bar")).toBe(saveBar);
    await waitFor(() => expect(within(settingsPanel).getByRole("button", { name: "Save" })).toBeDisabled());
  });

  it("refreshes the settings revision after a save conflict while preserving the draft (protects=the conflict reload choice appears and a later save uses the refreshed revision; fails_when=PATCH 409 leaves no reload choice or a second save sends the stale revision; no_claim=settings reads and writes are service mocks)", async () => {
    const remoteSettings = { ...settings, startBonus: 200 };
    const nextSettings = { ...settings, startBonus: 225 };
    mocks.savePointsSettings
      .mockRejectedValueOnce(new PanelApiError(409, "revision_conflict", { error: "revision_conflict" }))
      .mockResolvedValueOnce({ settings: nextSettings, revision: 3 });

    renderWithQuery(<UiProvider><PointsPanel channelId="kanal_demo" language="en" canManage /></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const settingsPanel = screen.getByLabelText("Points settings");
    const startBonus = within(settingsPanel).getByLabelText("Start balance");
    await waitFor(() => expect(startBonus).toBeEnabled());
    fireEvent.change(startBonus, { target: { value: "125" } });
    mocks.loadPointsSettings.mockResolvedValueOnce({ settings: remoteSettings, revision: 2 });
    fireEvent.click(within(settingsPanel).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(within(settingsPanel).getByRole("button", { name: "Load server version" })).toBeEnabled());
    expect(startBonus).toHaveValue("125");
    expect(within(settingsPanel).getByRole("status")).toHaveTextContent("changed in another session");

    fireEvent.click(within(settingsPanel).getByRole("button", { name: "Load server version" }));
    expect(startBonus).toHaveValue("200");
    fireEvent.change(startBonus, { target: { value: "225" } });
    fireEvent.click(within(settingsPanel).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.savePointsSettings).toHaveBeenCalledTimes(2));
    expect(mocks.savePointsSettings).toHaveBeenNthCalledWith(1, "kanal_demo", 1, expect.objectContaining({ startBonus: 125 }));
    expect(mocks.savePointsSettings).toHaveBeenNthCalledWith(2, "kanal_demo", 2, expect.objectContaining({ startBonus: 225 }));
  });

  it("keeps selected detail and history when a correction moves the account beyond the first 50 (protects=the selected account stays available independently of the current account page; fails_when=correction refetch removes its detail or history after it moves to page two; no_claim=account, correction, and history API results are in-memory service mocks)", async () => {
    const accounts = [
      { accountId: "viewer_target", login: "pixelpilz", balance: 1_000, monthNet: 0 },
      ...Array.from({ length: 50 }, (_unused, index) => ({
        accountId: `viewer_${String(index + 1).padStart(2, "0")}`,
        login: `nachtfalke${String(index + 1).padStart(2, "0")}`,
        balance: 100 - index,
        monthNet: 0,
      })),
    ];
    const history: { operationId: string; kind: string; moduleId: string; delta: number; balanceAfter: number; at: string; detail: unknown }[] = [];
    mocks.loadPointsAccounts.mockImplementation((_channelId: string, _sort: string, _search: string, cursor?: string) => {
      const sorted = [...accounts].sort((left, right) => right.balance - left.balance);
      const rows = cursor === undefined ? sorted.slice(0, 50) : sorted.slice(50, 100);
      return Promise.resolve({ rows, ...(sorted.length > 50 && cursor === undefined ? { cursor: "page-two" } : {}) });
    });
    mocks.loadPointsAccount.mockImplementation((_channelId: string, accountId: string) => {
      const account = accounts.find((entry) => entry.accountId === accountId);
      return Promise.resolve(account === undefined ? null : { accountId: account.accountId, login: account.login, balance: account.balance });
    });
    mocks.loadPointsHistory.mockImplementation((_channelId: string, accountId: string) => Promise.resolve({
      rows: accountId === "viewer_target" ? history : [],
    }));
    mocks.loadPointsSummary.mockResolvedValue({ circulation: 3_725, jackpots: {}, inRounds: 0, accounts: 51, month: "2026-10" });
    mocks.adjustPoints.mockImplementation((_channelId: string, accountId: string, operationId: string, delta: number, reason: string) => {
      const account = accounts.find((entry) => entry.accountId === accountId);
      if (account === undefined) throw new Error("missing account fixture");
      account.balance += delta;
      history.unshift({ operationId: `admin:${operationId}`, kind: "admin", moduleId: "points", delta, balanceAfter: account.balance, at: "2026-10-19T12:00:00.000Z", detail: { reason, actorLogin: "kanal_demo" } });
      return Promise.resolve({ balance: account.balance, auditPending: false });
    });

    const view = renderWithQuery(<UiProvider><PointsPanel channelId="kanal_demo" language="en" canManage /></UiProvider>);
    await waitFor(() => expect(mocks.loadPointsAccounts).toHaveBeenCalled());
    const accountQuery = view.queryClient.getQueryCache().getAll().find((query) =>
      query.queryKey[0] === "channel" && query.queryKey[1] === "kanal_demo" && query.queryKey[4] === "accounts:balance::first");
    expect(accountQuery?.state.status).toBe("success");
    expect((accountQuery?.state.data as { rows: unknown[] } | undefined)?.rows).toHaveLength(50);
    expect((accountQuery?.state.data as { rows: unknown[] } | undefined)?.rows).toContainEqual(expect.objectContaining({ accountId: "viewer_target", login: "pixelpilz" }));
    const target = await screen.findByText("pixelpilz", { exact: true });
    const targetButton = target.closest("button");
    expect(targetButton).not.toBeNull();
    fireEvent.click(targetButton as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText("Amount ±"), { target: { value: "-952" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "first page correction" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(accounts[0]?.balance).toBe(48));
    await waitFor(() => expect(screen.getByRole("heading", { name: "pixelpilz" })).toBeVisible());
    expect(mocks.loadPointsAccounts.mock.calls.at(-1)?.[3]).toBeUndefined();
    expect(mocks.loadPointsAccount).toHaveBeenCalledWith("kanal_demo", "viewer_target", expect.anything());
    expect(await screen.findByText("Correction · first page correction · by kanal_demo")).toBeVisible();
    expect(screen.getByRole("table", { name: "History" })).toHaveTextContent("952");
  });

  it("keeps pagination visible when an account correction empties page two (protects=an empty later page shows a page hint and active Previous control while the account collection exists; fails_when=the panel says there are no accounts or removes pagination after the last row moves to page one; no_claim=the 51 account pages and correction result are service mocks)", async () => {
    const accounts = Array.from({ length: 51 }, (_unused, index) => ({
      accountId: `viewer_${String(index + 1).padStart(2, "0")}`,
      login: `nachtfalke${String(index + 1).padStart(2, "0")}`,
      balance: 51 - index,
      monthNet: 0,
    }));
    const target = accounts[50];
    if (target === undefined) throw new Error("The account fixture is missing its last row.");
    const initialBoundaryBalance = 2;
    mocks.loadPointsAccounts.mockImplementation((_channelId: string, _sort: string, _search: string, cursor?: string) => {
      const sorted = [...accounts].sort((left, right) => right.balance - left.balance);
      const rows = cursor === undefined ? sorted.slice(0, 50) : sorted.filter((account) => account.balance < initialBoundaryBalance).slice(0, 50);
      return Promise.resolve({ rows, ...(sorted.length > 50 && cursor === undefined ? { cursor: "page-two" } : {}) });
    });
    mocks.loadPointsAccount.mockImplementation((_channelId: string, accountId: string) => {
      const account = accounts.find((entry) => entry.accountId === accountId);
      return Promise.resolve(account === undefined ? null : { accountId: account.accountId, login: account.login, balance: account.balance });
    });
    mocks.adjustPoints.mockImplementation((_channelId: string, accountId: string, _operationId: string, delta: number) => {
      const account = accounts.find((entry) => entry.accountId === accountId);
      if (account === undefined) throw new Error("missing account fixture");
      account.balance += delta;
      return Promise.resolve({ balance: account.balance, auditPending: false });
    });
    mocks.loadPointsSummary.mockResolvedValue({ circulation: 1_326, jackpots: {}, inRounds: 0, accounts: 51, month: "2026-10" });

    const view = renderWithQuery(<UiProvider><PointsPanel channelId="kanal_demo" language="en" canManage /></UiProvider>);
    await screen.findByText("nachtfalke01", { exact: true });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const secondPageAccount = await screen.findByText("nachtfalke51", { exact: true });
    fireEvent.click(secondPageAccount.closest("button") as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText("Amount ±"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "move to page one" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.loadPointsAccounts).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("No accounts on this page.", { exact: true })).toBeVisible();
    expect(screen.queryByText("No accounts yet. Points start when someone chats.", { exact: true })).toBeNull();
    const accountList = view.container.querySelector(".collection-page__list");
    if (!(accountList instanceof HTMLElement)) throw new Error("The account collection frame is missing.");
    expect(within(accountList).getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(within(accountList).getByRole("button", { name: "Next" })).toBeDisabled();
    expect(accountList.querySelector(".list-pagination-footer")).not.toBeNull();
  });

  it("unlocks a definite server overflow rejection (protects=a 400 balance overflow rejection restores editable correction controls; fails_when=the panel keeps retry state or shows a generic correction error; no_claim=the correction response is supplied by a service mock)", async () => {
    const accounts = [
      { accountId: "viewer_demo", login: "pixelpilz", balance: 100, monthNet: 0 },
    ];
    mocks.loadPointsAccounts.mockResolvedValue({ rows: accounts });
    mocks.loadPointsAccount.mockImplementation((_channelId: string, accountId: string) => {
      const account = accounts.find((entry) => entry.accountId === accountId);
      return Promise.resolve(account === undefined ? null : { accountId: account.accountId, login: account.login, balance: account.balance });
    });
    mocks.adjustPoints.mockRejectedValue(new PanelApiError(400, "balance_overflow", { error: "balance_overflow" }));

    const view = renderWithQuery(<UiProvider><PointsPanel channelId="kanal_demo" language="en" canManage /></UiProvider>);
    const firstAccount = await screen.findByText("pixelpilz", { exact: true });
    fireEvent.click(firstAccount.closest("button") as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText("Amount ±"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "server overflow rejection" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const detailHeader = view.container.querySelector(".points-detail__header");
    if (!(detailHeader instanceof HTMLElement)) throw new Error("The selected account detail header is missing.");
    const header = within(detailHeader);
    await waitFor(() => expect(header.getByRole("status")).toHaveTextContent("safe range"));
    expect(header.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(header.getByRole("button", { name: "Discard" })).toBeEnabled();
    expect(header.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByLabelText("Amount ±")).toBeEnabled();
  });

  it("reuses a booked correction after an authentication failure and recovery (protects=an uncertain correction keeps its exact operation identity and payload until the ledger confirms success or definite rejection; fails_when=a 401/403 clears retry state, a new operation id is generated, or the ledger balance changes twice; no_claim=the panel uses the real UI and an idempotent in-memory ledger behind the service boundary)", async () => {
    let ledgerBalance = 100;
    const bookings = new Map<string, number>();
    const attempts: { operationId: string; delta: number; reason: string }[] = [];
    mocks.loadPointsAccounts.mockResolvedValue({ rows: [{ accountId: "viewer_demo", login: "pixelpilz", balance: 100, monthNet: 0 }] });
    mocks.loadPointsAccount.mockImplementation(() => Promise.resolve({ accountId: "viewer_demo", login: "pixelpilz", balance: ledgerBalance }));
    mocks.adjustPoints.mockImplementation((_channelId: string, _accountId: string, operationId: string, delta: number, reason: string) => {
      attempts.push({ operationId, delta, reason });
      const existingBooking = bookings.get(operationId);
      if (attempts.length === 2) return Promise.reject(new PanelApiError(401, "unauthorized", { error: "unauthorized" }));
      if (existingBooking !== undefined) return Promise.resolve({ balance: existingBooking, auditPending: false });
      ledgerBalance += delta;
      bookings.set(operationId, ledgerBalance);
      return Promise.resolve({ balance: ledgerBalance, auditPending: attempts.length === 1 });
    });

    const view = renderWithQuery(<UiProvider><PointsPanel channelId="kanal_demo" language="en" canManage /></UiProvider>);
    const firstAccount = await screen.findByText("pixelpilz", { exact: true });
    fireEvent.click(firstAccount.closest("button") as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText("Amount ±"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "welcome correction" } });

    const detailHeader = view.container.querySelector(".points-detail__header");
    if (!(detailHeader instanceof HTMLElement)) throw new Error("The selected account detail header is missing.");
    const header = within(detailHeader);
    fireEvent.click(header.getByRole("button", { name: "Save" }));
    fireEvent.click(await header.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(header.getByRole("status").querySelector(".ui-save-bar__message")).toHaveTextContent("could not be saved"));
    expect(header.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByLabelText("Amount ±")).toBeDisabled();
    expect(screen.getByLabelText("Reason")).toBeDisabled();

    fireEvent.click(header.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(header.getByRole("status").querySelector(".ui-save-bar__message")).toHaveTextContent("Saved"));

    expect(attempts).toHaveLength(3);
    expect(attempts[0]?.operationId).toBeTruthy();
    expect(attempts.map(({ operationId }) => operationId)).toEqual(Array(3).fill(attempts[0]?.operationId));
    expect(attempts.map(({ delta, reason }) => ({ delta, reason }))).toEqual(Array(3).fill({ delta: 10, reason: "welcome correction" }));
    expect(ledgerBalance).toBe(110);
    expect(bookings).toHaveLength(1);
    expect(view.container.querySelector(".points-detail__balance")).toHaveTextContent("110");
  });

  it("blocks an unsafe resulting balance before calling the correction API (protects=the client rejects a correction whose resulting balance is outside the safe integer range; fails_when=the Save action stays enabled or the API receives an unsafe balance; no_claim=the selected balance is supplied by an account service mock)", async () => {
    const account = { accountId: "viewer_edge", login: "funkenflug", balance: Number.MAX_SAFE_INTEGER, monthNet: 0 };
    mocks.loadPointsAccounts.mockResolvedValue({ rows: [account] });
    mocks.loadPointsAccount.mockResolvedValue({ accountId: account.accountId, login: account.login, balance: account.balance });

    const view = renderWithQuery(<UiProvider><PointsPanel channelId="kanal_demo" language="en" canManage /></UiProvider>);
    const edgeAccount = await screen.findByText("funkenflug", { exact: true });
    fireEvent.click(edgeAccount.closest("button") as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText("Amount ±"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "client overflow check" } });
    const preview = view.container.querySelector(".points-correction__preview");
    if (preview === null) throw new Error("The correction preview slot is missing.");
    expect(preview).toHaveTextContent("safe range");
    const detailHeader = view.container.querySelector(".points-detail__header");
    if (!(detailHeader instanceof HTMLElement)) throw new Error("The selected account detail header is missing.");
    const saveButton = within(detailHeader).getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);
    expect(mocks.adjustPoints).not.toHaveBeenCalled();
  });
});
