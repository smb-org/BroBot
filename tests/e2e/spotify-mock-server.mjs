import { createServer } from "node:http";
import process from "node:process";
import { URL, URLSearchParams } from "node:url";

const port = Number(process.env.SPOTIFY_MOCK_PORT ?? 8791);
const rankedChannelId = "discord-reconcile-e2e-ranked";
const rankedViewer = { user_id: "990000000000000301", user_login: "pixelpilot_e2e", user_name: "Pixel Pilot" };
const tracks = [
  {
    id: "glassharbor01", uri: "spotify:track:glassharbor01", name: "Glass Harbor", duration_ms: 201000, explicit: false,
    artists: [{ id: "miravale01", name: "Mira Vale" }],
    album: { name: "Quiet Atlas", images: [{ url: "https://i.scdn.co/image/fictional-cover-one", width: 640, height: 640 }] },
    external_urls: { spotify: "https://open.spotify.com/track/glassharbor01" },
  },
  {
    id: "quietatlas02", uri: "spotify:track:quietatlas02", name: "Quiet Atlas", duration_ms: 198000, explicit: false,
    artists: [{ id: "miravale01", name: "Mira Vale" }],
    album: { name: "Glass Harbor", images: [{ url: "https://i.scdn.co/image/fictional-cover-two", width: 640, height: 640 }] },
    external_urls: { spotify: "https://open.spotify.com/track/quietatlas02" },
  },
  {
    id: "silvercurrent03", uri: "spotify:track:silvercurrent03", name: "Silver Current", duration_ms: 207000, explicit: false,
    artists: [{ id: "rowanmarch01", name: "Rowan March" }],
    album: { name: "North Window", images: [{ url: "https://i.scdn.co/image/fictional-cover-three", width: 640, height: 640 }] },
    external_urls: { spotify: "https://open.spotify.com/track/silvercurrent03" },
  },
];
let queue = [];
let current = null;
let nextRequests = 0;
const redemptions = new Map();

const json = (response, status, value) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};

const readJson = (request) => new Promise((resolve, reject) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
  });
  request.on("error", reject);
});

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/__test/reset" && request.method === "POST") {
    queue = [];
    current = null;
    nextRequests = 0;
    redemptions.clear();
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/__test/redemptions" && request.method === "POST") {
    void readJson(request).then((value) => {
      if (typeof value !== "object" || value === null || typeof value.id !== "string" ||
          typeof value.status !== "string" || !["UNFULFILLED", "FULFILLED", "CANCELED"].includes(value.status)) {
        json(response, 400, { error: "redemption_invalid" });
        return;
      }
      redemptions.set(value.id, value);
      json(response, 201, { accepted: true });
    }).catch(() => json(response, 400, { error: "redemption_invalid" }));
    return;
  }
  if (url.pathname === "/__test/state" && request.method === "GET") {
    json(response, 200, { currentTrackId: current?.id ?? null, nextRequests });
    return;
  }
  if ((url.pathname === "/helix/channels/vips" || url.pathname === "/helix/moderation/moderators") && request.method === "GET") {
    const isRankedChannel = url.searchParams.get("broadcaster_id") === rankedChannelId;
    const data = url.pathname === "/helix/channels/vips" && isRankedChannel ? [rankedViewer] : [];
    json(response, 200, { data, pagination: {} });
    return;
  }
  if (url.pathname === "/__test/redemptions" && request.method === "GET") {
    json(response, 200, { items: [...redemptions.values()].map(({ id, status }) => ({ id, status })) });
    return;
  }
  if (url.pathname === "/helix/channel_points/custom_rewards/redemptions" && request.method === "GET") {
    const ids = url.searchParams.getAll("id");
    json(response, 200, { data: ids.flatMap((id) => {
      const redemption = redemptions.get(id);
      return redemption === undefined ? [] : [redemption];
    }), pagination: {} });
    return;
  }
  if (url.pathname === "/helix/channel_points/custom_rewards/redemptions" && request.method === "PATCH") {
    void readJson(request).then((value) => {
      if (typeof value !== "object" || value === null ||
          (value.status !== "FULFILLED" && value.status !== "CANCELED")) {
        json(response, 400, { error: "redemption_status_invalid" });
        return;
      }
      for (const id of url.searchParams.getAll("id")) {
        const redemption = redemptions.get(id);
        if (redemption !== undefined) redemptions.set(id, { ...redemption, status: value.status });
      }
      json(response, 200, { data: [] });
    }).catch(() => json(response, 400, { error: "redemption_status_invalid" }));
    return;
  }
  if (url.pathname === "/authorize" && request.method === "GET") {
    const redirect = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (redirect === null || state === null) {
      json(response, 400, { error: "authorization_request_invalid" });
      return;
    }
    const callback = new URL(redirect);
    callback.searchParams.set("code", "fictional-authorization-code");
    callback.searchParams.set("state", state);
    response.writeHead(302, { Location: callback.toString() });
    response.end();
    return;
  }
  if (url.pathname === "/api/token" && request.method === "POST") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const fields = new URLSearchParams(body);
      const authorization = fields.get("grant_type") === "authorization_code";
      json(response, 200, {
        access_token: "fictional-spotify-access-token",
        token_type: "Bearer",
        scope: "user-modify-playback-state user-read-playback-state user-read-currently-playing",
        expires_in: 3600,
        ...(authorization ? { refresh_token: "fictional-spotify-refresh-token" } : {}),
      });
    });
    return;
  }
  if (url.pathname === "/v1/search" && request.method === "GET") {
    json(response, 200, { tracks: { items: tracks, total: tracks.length, limit: 10, offset: 0 } });
    return;
  }
  const trackId = /^\/v1\/tracks\/([A-Za-z0-9]+)$/u.exec(url.pathname)?.[1];
  if (trackId !== undefined && request.method === "GET") {
    const track = tracks.find((entry) => entry.id === trackId);
    if (track === undefined) {
      json(response, 404, { error: { status: 404, message: "Track not found" } });
      return;
    }
    json(response, 200, track);
    return;
  }
  if (url.pathname === "/v1/me/player/queue" && request.method === "POST") {
    const uri = url.searchParams.get("uri");
    const track = tracks.find((entry) => entry.uri === uri);
    if (track === undefined) {
      json(response, 400, { error: { status: 400, message: "Invalid track URI" } });
      return;
    }
    queue.push(track);
    current ??= track;
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/v1/me/player/next" && request.method === "POST") {
    nextRequests += 1;
    if (current === null) {
      json(response, 404, { error: { status: 404, message: "No active device", reason: "NO_ACTIVE_DEVICE" } });
      return;
    }
    if (queue[0]?.id === current.id) queue.shift();
    current = queue[0] ?? null;
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/v1/me/player/currently-playing" && request.method === "GET") {
    if (current === null) {
      response.writeHead(204);
      response.end();
      return;
    }
    json(response, 200, { is_playing: true, progress_ms: 0, currently_playing_type: "track", item: current });
    return;
  }
  if (url.pathname === "/v1/me/player/queue" && request.method === "GET") {
    json(response, 200, { currently_playing: current, queue: queue.slice(current === null ? 0 : 1) });
    return;
  }
  json(response, 404, { error: { status: 404, message: "Mock endpoint not found" } });
});

server.listen(port, "127.0.0.1");
server.on("error", (error) => {
  process.stderr.write(`Spotify mock server failed: ${error.message}\n`);
  process.exitCode = 1;
});

const close = () => server.close(() => process.exit());
process.on("SIGTERM", close);
process.on("SIGINT", close);
