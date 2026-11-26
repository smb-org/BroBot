import { createServer } from "node:http";
import process from "node:process";
import { URL, URLSearchParams } from "node:url";

const port = Number(process.env.DISCORD_MOCK_PORT ?? 8792);
const discordUser = {
  id: "80351110224678912",
  username: "nightowl",
  global_name: "Night Owl",
  discriminator: "0",
  avatar: null,
};
const discordBot = {
  id: "990000000000000201",
  username: "brobot_test",
  bot: true,
  discriminator: "0",
  avatar: null,
};
const guildId = "990000000000000101";
const guild = {
  id: guildId,
  name: "Lantern Harbor",
  icon: null,
  owner_id: "990000000000000044",
  roles: [],
};
const roles = [
  { id: guildId, name: "@everyone", color: 0, hoist: false, icon: null, unicode_emoji: null, position: 0, permissions: "0", managed: false, mentionable: false, flags: 0 },
  { id: "990000000000000102", name: "VIP", color: 15844367, hoist: true, icon: null, unicode_emoji: null, position: 3, permissions: "0", managed: false, mentionable: false, flags: 0 },
  { id: "990000000000000103", name: "Moderator", color: 5793266, hoist: true, icon: null, unicode_emoji: null, position: 2, permissions: "0", managed: false, mentionable: false, flags: 0 },
  { id: "990000000000000105", name: "Harbor Sentinel", color: 0, hoist: false, icon: null, unicode_emoji: null, position: 5, permissions: "0", managed: false, mentionable: false, flags: 0 },
  { id: "990000000000000104", name: "BroBot", color: 0, hoist: false, icon: null, unicode_emoji: null, position: 5, permissions: "268435456", managed: true, mentionable: false, flags: 0, tags: { bot_id: discordBot.id } },
];
const connections = [{
  id: "141981764",
  name: "nightowl_dev",
  type: "twitch",
  verified: true,
  visibility: 0,
  friend_sync: false,
  show_activity: true,
  two_way_link: false,
  revoked: false,
}];

const json = (response, status, value) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};

const readForm = (request) => new Promise((resolve, reject) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => resolve(new URLSearchParams(body)));
  request.on("error", reject);
});

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/oauth2/authorize" && request.method === "GET") {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (redirectUri === null || state === null) {
      json(response, 400, { error: "authorization_request_invalid" });
      return;
    }
    const scope = url.searchParams.get("scope");
    const serverInvite = scope === "bot" && url.searchParams.get("permissions") === "268435456";
    if (!serverInvite && scope !== "identify connections") {
      json(response, 400, { error: "authorization_request_invalid" });
      return;
    }
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", serverInvite ? "fictional-discord-server-authorization-code" : "fictional-discord-authorization-code");
    callback.searchParams.set("state", state);
    if (serverInvite) {
      callback.searchParams.set("guild_id", "990000000000000199");
      callback.searchParams.set("permissions", "0");
    }
    response.writeHead(302, { Location: callback.toString() });
    response.end();
    return;
  }
  if (url.pathname === "/api/oauth2/token" && request.method === "POST") {
    void readForm(request).then((fields) => {
      if (fields.get("grant_type") !== "authorization_code" || fields.get("client_id") === null ||
          fields.get("client_secret") === null || !["fictional-discord-authorization-code", "fictional-discord-server-authorization-code"].includes(fields.get("code") ?? "")) {
        json(response, 400, { error: "token_request_invalid" });
        return;
      }
      if (fields.get("code") === "fictional-discord-server-authorization-code") {
        json(response, 200, {
          access_token: "fictional-discord-temporary-invite-token",
          token_type: "Bearer",
          expires_in: 604800,
          refresh_token: "fictional-discord-temporary-refresh-token",
          scope: "bot",
          guild: { ...guild, roles: [] },
        });
        return;
      }
      json(response, 200, {
        access_token: "fictional-discord-access-token",
        token_type: "Bearer",
        expires_in: 604800,
        refresh_token: "fictional-discord-refresh-token",
        scope: "identify connections",
      });
    }).catch(() => json(response, 400, { error: "token_request_invalid" }));
    return;
  }
  if (url.pathname === "/api/v10/users/@me" && request.method === "GET") {
    json(response, 200, request.headers.authorization === "Bot e2e-discord-bot-token" ? discordBot : discordUser);
    return;
  }
  if (url.pathname === "/api/v10/users/@me/connections" && request.method === "GET") {
    json(response, 200, connections);
    return;
  }
  if (url.pathname === `/api/v10/guilds/${guildId}` && request.method === "GET") {
    json(response, 200, { ...guild, roles });
    return;
  }
  if (url.pathname === `/api/v10/guilds/${guildId}/roles` && request.method === "GET") {
    json(response, 200, roles);
    return;
  }
  if (url.pathname === `/api/v10/guilds/${guildId}/members/${discordBot.id}` && request.method === "GET") {
    json(response, 200, {
      user: { id: discordBot.id, username: discordBot.username, bot: true },
      roles: ["990000000000000104"],
      joined_at: "2026-11-20T18:00:00.000000+00:00",
      nick: null,
      deaf: false,
      mute: false,
      flags: 0,
    });
    return;
  }
  json(response, 404, { error: "mock_endpoint_not_found" });
});

server.listen(port, "127.0.0.1");
server.on("error", (error) => {
  process.stderr.write(`Discord mock server failed: ${error.message}\n`);
  process.exitCode = 1;
});

const close = () => server.close(() => process.exit());
process.on("SIGTERM", close);
process.on("SIGINT", close);
