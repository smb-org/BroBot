import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TwitchUserField, type TwitchUserFieldHandle } from "../../src/dashboard/ui/TwitchUserField";
import type { PanelTwitchUser } from "../../src/panel-contract";

const user: PanelTwitchUser = {
  userId: "100",
  login: "chatfreund",
  displayName: "Chatfreund",
  profileImageUrl: "https://static.example/chatfreund.png",
};

const resultFor = (users: readonly PanelTwitchUser[] = [user]) => ({ users, partial: false });

describe("TwitchUserField", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("strips a leading @ and whitespace while typing, then waits 250 ms before searching", async () => {
    vi.useFakeTimers();
    const loadSuggestions = vi.fn(() => Promise.resolve(resultFor()));
    render(<TwitchUserField channelId="channel-a" label="Twitch user" hint="Choose a user" language="en"
      value={null} onChange={vi.fn()} loadSuggestions={loadSuggestions} />);

    const input = screen.getByRole("combobox", { name: "Twitch user" });
    fireEvent.change(input, { target: { value: " @ chat freund " } });

    expect(input).toHaveValue("chatfreund");
    expect(loadSuggestions).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(loadSuggestions).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(loadSuggestions).toHaveBeenCalledWith("chatfreund", expect.any(AbortSignal));
  });

  it("aborts an older request as soon as a newer query is entered", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const loadSuggestions = vi.fn((_query: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<ReturnType<typeof resultFor>>(() => undefined);
    });
    render(<TwitchUserField channelId="channel-a" label="Twitch user" hint="Choose a user" language="en"
      value={null} onChange={vi.fn()} loadSuggestions={loadSuggestions} />);

    const input = screen.getByRole("combobox", { name: "Twitch user" });
    fireEvent.change(input, { target: { value: "chat" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fireEvent.change(input, { target: { value: "chatf" } });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("supports arrow-key selection and Escape closes the suggestion overlay", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<TwitchUserField channelId="channel-a" label="Twitch user" hint="Choose a user" language="en"
      value={null} onChange={onChange} loadSuggestions={() => Promise.resolve(resultFor())} />);

    const input = screen.getByRole("combobox", { name: "Twitch user" });
    fireEvent.change(input, { target: { value: "chat" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByRole("option", { name: /Chatfreund/u })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith(user);
    expect(input).toHaveValue("chatfreund");
    expect(input).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(input, { target: { value: "chat" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveValue("chat");
  });

  it("resolves exact free text when a submit handler asks the field to resolve", async () => {
    const reference = createRef<TwitchUserFieldHandle>();
    const onChange = vi.fn();
    render(<TwitchUserField ref={reference} channelId="channel-a" label="Twitch user" hint="Choose a user" language="en"
      value={null} onChange={onChange} loadSuggestions={() => Promise.resolve(resultFor())} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Twitch user" }), { target: { value: "@chatfreund" } });

    await expect(reference.current?.resolve()).resolves.toEqual(user);
    expect(onChange).toHaveBeenLastCalledWith(user);
  });

  it("shows not found after an unknown free-text login loses focus", async () => {
    render(<TwitchUserField channelId="channel-a" label="Twitch user" hint="Choose a user" language="en"
      value={null} onChange={vi.fn()} loadSuggestions={() => Promise.resolve(resultFor([]))} />);

    const input = screen.getByRole("combobox", { name: "Twitch user" });
    fireEvent.change(input, { target: { value: "unknownlogin" } });
    fireEvent.blur(input);

    expect(await screen.findByText("User not found")).toBeInTheDocument();
  });

  it("keeps unknown free text unresolved when submit asks the field to resolve it", async () => {
    const reference = createRef<TwitchUserFieldHandle>();
    const onChange = vi.fn();
    render(<TwitchUserField ref={reference} channelId="channel-a" label="Twitch user" hint="Choose a user" language="en"
      value={null} onChange={onChange} loadSuggestions={() => Promise.resolve(resultFor([]))} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Twitch user" }), { target: { value: "unknownlogin" } });

    await expect(reference.current?.resolve()).resolves.toBeNull();
    expect(await screen.findByText("User not found")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
