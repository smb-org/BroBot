import { afterEach, describe, expect, it } from "vitest";

import {
  beginSpotifyOAuth,
  consumeSpotifyOAuthTransaction,
  verifySpotifyOAuthState,
} from "../../src/worker/auth/spotify-oauth";
import { insertChannel, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-oauth";
const COOKIE_KEYS = JSON.stringify({ active: { id: "test-cookie", key: testKey(21) }, retired: [] });
const databases: TestD1Database[] = [];

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("Spotify OAuth transaction", () => {
  it("binds signed OAuth state to its member and consumes the transaction once", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, CHANNEL_ID);
    const started = await beginSpotifyOAuth(database as unknown as D1Database, {
      SESSION_COOKIE_KEYS: COOKIE_KEYS,
      SPOTIFY_CLIENT_ID: "fictional-client",
      SPOTIFY_CLIENT_SECRET: "fictional-secret",
    }, CHANNEL_ID, "member-fictional", "https://brobot.example/auth/spotify/callback", "2026-11-15T12:00:00.000Z");
    const url = new URL(started.authorizationUrl);
    const stateToken = url.searchParams.get("state");
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBeNull();
    expect(stateToken).not.toBeNull();
    const state = await verifySpotifyOAuthState(stateToken ?? "", started.stateNonce, COOKIE_KEYS, "2026-11-15T12:01:00.000Z");
    expect(state).toMatchObject({ channelId: CHANNEL_ID, memberUserId: "member-fictional" });
    expect(await verifySpotifyOAuthState(stateToken ?? "", "wrong-cookie-nonce", COOKIE_KEYS, "2026-11-15T12:01:00.000Z")).toBeNull();
    expect(await verifySpotifyOAuthState(stateToken ?? "", started.stateNonce, COOKIE_KEYS, "2026-11-15T12:11:00.000Z")).toBeNull();
    if (state === null) throw new Error("The signed state must verify.");
    const firstUse = await consumeSpotifyOAuthTransaction(database as unknown as D1Database, state, "2026-11-15T12:01:00.000Z");
    expect(firstUse).toMatchObject({ channelId: CHANNEL_ID, memberUserId: "member-fictional" });
    expect(firstUse).not.toHaveProperty("codeVerifier");
    const columns = await database.prepare("PRAGMA table_info(spotify_oauth_transactions)").all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).not.toContain("code_verifier");
    expect(await consumeSpotifyOAuthTransaction(database as unknown as D1Database, state, "2026-11-15T12:01:01.000Z")).toBeNull();
  });
});
