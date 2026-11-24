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
    if (redirectUri === null || state === null || url.searchParams.get("scope") !== "identify connections") {
      json(response, 400, { error: "authorization_request_invalid" });
      return;
    }
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "fictional-discord-authorization-code");
    callback.searchParams.set("state", state);
    response.writeHead(302, { Location: callback.toString() });
    response.end();
    return;
  }
  if (url.pathname === "/api/oauth2/token" && request.method === "POST") {
    void readForm(request).then((fields) => {
      if (fields.get("grant_type") !== "authorization_code" || fields.get("client_id") === null ||
          fields.get("client_secret") === null || fields.get("code") !== "fictional-discord-authorization-code") {
        json(response, 400, { error: "token_request_invalid" });
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
    json(response, 200, discordUser);
    return;
  }
  if (url.pathname === "/api/v10/users/@me/connections" && request.method === "GET") {
    json(response, 200, connections);
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
