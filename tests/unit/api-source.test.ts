import { Hono } from "hono";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleRouteEnvironment } from "../../src/modules/contract";
import { API_SOURCE_VALUE_VARIABLE, apiSourceModule } from "../../src/modules/api_source";
import { fetchCachedApiSourceJson } from "../../src/modules/api_source/adapters/fetch-json";
import { claimApiSourceQuota } from "../../src/modules/api_source/adapters/d1";
import {
  ALLOWED_FUNCTIONS,
  evaluateApiSourceExpression,
  inspectApiSourceExpression,
  JSONATA_LIMITS,
  OWN_IMPLEMENTATION_FUNCTIONS,
  SAFE_BUILTIN_FUNCTIONS,
  validateJsonataExpression,
} from "../../src/modules/api_source/domain";
import { isValidApiSourceUrl, validateApiSourceUrl } from "../../src/modules/api_source/domain/url";
import { apiSourcePanelTexts } from "../../src/modules/api_source/panel/locale";
import { apiSourceRoutes } from "../../src/modules/api_source/routes";
import { textLibraryModule } from "../../src/modules/text_library";
import { createTemplateRenderer, type TemplateResolverSources } from "../../src/worker/template-resolver";
import { createTextBlockTemplateValueProvider } from "../../src/modules/text_library/adapters/template-expander";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "api-source-test-channel";
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const databaseInstances: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databaseInstances.push(database);
  await insertChannel(database, CHANNEL_ID);
  return database;
};

const jsonResponse = (payload: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "Content-Type": "application/json", ...headers },
});

const insertSource = async (
  database: TestD1Database,
  name: string,
  expression: string,
  url = "https://api.sample-provider.net/data",
): Promise<void> => {
  await database.prepare(
    `INSERT INTO api_sources (channel_id, source_name, url, expression, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).bind(CHANNEL_ID, name, url, expression, new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();
};

const sharedBudget = (maximum = 3): { claim: () => boolean; count: () => number } => {
  let count = 0;
  return {
    claim: () => {
      if (count >= maximum) return false;
      count += 1;
      return true;
    },
    count: () => count,
  };
};

afterEach(() => {
  for (const database of databaseInstances.splice(0)) database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API source URL policy", () => {
  it("rejects non-HTTPS URLs, credentials, ports, IP literals, reserved hosts, and Cloudflare or own hosts", () => {
    const rejected = [
      "http://api.example.net/data",
      "https://user:password@api.example.net/data",
      "https://api.example.net:8443/data",
      "https://127.0.0.1/data",
      "https://0.0.0.0/data",
      "https://10.0.0.4/data",
      "https://192.168.1.1/data",
      "https://192.0.2.1/data",
      "https://100.64.0.1/data",
      "https://169.254.169.254/latest/meta-data/",
      "https://224.0.0.1/data",
      "https://240.0.0.1/data",
      "https://[::1]/data",
      "https://[::]/data",
      "https://[fe80::1]/data",
      "https://[fc00::1]/data",
      "https://[ff02::1]/data",
      "https://[::ffff:127.0.0.1]/data",
      "https://[::ffff:8.8.8.8]/data",
      "https://example.com/data",
      "https://api.cloudflare.com/data",
      "https://api.cloudflare.net/data",
      "https://worker-name.workers.dev/data",
      "https://brobot.esembe.app/healthz",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://api.sample-provider.net/data#fragment",
    ];
    for (const url of rejected) expect(isValidApiSourceUrl(url), url).toBe(false);
    expect(isValidApiSourceUrl("https://api.sample-provider.net/data", "https://api.sample-provider.net")).toBe(false);
  });

  it("accepts public HTTPS DNS names and canonicalizes default port 443", () => {
    expect(validateApiSourceUrl("https://api.sample-provider.net:443/data").href)
      .toBe("https://api.sample-provider.net/data");
    expect(isValidApiSourceUrl("https://api.sample-provider.net/v1/data?currency=EUR")).toBe(true);
  });
});

describe("API source outbound fetch", () => {
  it("uses only fixed headers, omits credentials, and caches successful JSON by channel and URL", async () => {
    const database = await createDatabase();
    const payload = { value: 42 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload, { "Cache-Control": "max-age=60" }));
    const budget = sharedBudget();
    const db = database as unknown as D1Database;
    const first = await fetchCachedApiSourceJson(db, CHANNEL_ID, "https://api.sample-provider.net/data", undefined, NOW, budget, fetcher);
    const second = await fetchCachedApiSourceJson(db, CHANNEL_ID, "https://api.sample-provider.net/data", undefined, NOW + 1_000, budget, fetcher);
    const [, request] = fetcher.mock.calls[0] ?? [];

    expect(first).toEqual(payload);
    expect(second).toEqual(payload);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(request?.headers).get("User-Agent")).toBe("BroBot/0.1.0 (+https://github.com/smb-org/BroBot)");
    expect([...new Headers(request?.headers).keys()].sort((a, b) => a.localeCompare(b))).toEqual(["accept", "user-agent"]);
    expect(request).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(budget.count()).toBe(1);
  });

  it("keeps the same upstream URL isolated between channels", async () => {
    const database = await createDatabase();
    await insertChannel(database, "another-api-source-channel");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ value: "first" }, { "Cache-Control": "max-age=60" }))
      .mockResolvedValueOnce(jsonResponse({ value: "second" }, { "Cache-Control": "max-age=60" }));
    const db = database as unknown as D1Database;

    const first = await fetchCachedApiSourceJson(db, CHANNEL_ID, "https://api.sample-provider.net/shared", undefined, NOW, sharedBudget(), fetcher);
    const second = await fetchCachedApiSourceJson(db, "another-api-source-channel", "https://api.sample-provider.net/shared", undefined, NOW, sharedBudget(), fetcher);

    expect(first).toEqual({ value: "first" });
    expect(second).toEqual({ value: "second" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not cache responses marked private", async () => {
    const database = await createDatabase();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ value: "first" }, { "Cache-Control": "private, max-age=60" }))
      .mockResolvedValueOnce(jsonResponse({ value: "second" }, { "Cache-Control": "private, max-age=60" }));
    const db = database as unknown as D1Database;

    const first = await fetchCachedApiSourceJson(db, CHANNEL_ID, "https://api.sample-provider.net/private", undefined, NOW, sharedBudget(), fetcher);
    const second = await fetchCachedApiSourceJson(db, CHANNEL_ID, "https://api.sample-provider.net/private", undefined, NOW, sharedBudget(), fetcher);

    expect(first).toEqual({ value: "first" });
    expect(second).toEqual({ value: "second" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a regex expression when saving and names the rejected construct", async () => {
    const database = await createDatabase();
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "manager");
      context.set("actor", { userId: "api-source-manager", sessionId: "api-source-session" });
      await next();
    });
    app.route("/channels/:channelId", apiSourceRoutes);
    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "unsafe",
        url: "https://api.sample-provider.net/data",
        expression: "$contains($.value, /(a+)+$/)",
      }),
    }), { DB: database as unknown as D1Database });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "api_source_construct_not_allowed", constructName: "regex literal" });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM api_sources WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("rejects response bodies larger than the shared 64 KiB bound", async () => {
    const database = await createDatabase();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ value: "x".repeat(64 * 1024) }));

    await expect(fetchCachedApiSourceJson(
      database as unknown as D1Database,
      CHANNEL_ID,
      "https://api.sample-provider.net/large",
      undefined,
      NOW,
      sharedBudget(),
      fetcher,
    )).rejects.toThrow("JSON response exceeded the size limit");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["private IPv4", "http://127.0.0.1/healthz"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/healthz"],
    ["the configured service origin", "https://brobot.esembe.app/healthz"],
  ])("rejects a redirect to %s before making a second request", async (_description, target) => {
    const database = await createDatabase();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: target },
    }));
    const budget = sharedBudget();

    await expect(fetchCachedApiSourceJson(
      database as unknown as D1Database,
      CHANNEL_ID,
      "https://api.sample-provider.net/start",
      "https://brobot.esembe.app",
      NOW,
      budget,
      fetcher,
    )).rejects.toThrow("API source URL is not allowed");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(budget.count()).toBe(1);
  });

  it("follows no more than three redirects and caps outbound requests at three per invocation", async () => {
    const database = await createDatabase();
    let hop = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      hop += 1;
      return Promise.resolve(new Response(null, {
        status: 302,
        headers: { Location: `/hop-${String(hop)}` },
      }));
    });
    const budget = sharedBudget();

    await expect(fetchCachedApiSourceJson(
      database as unknown as D1Database,
      CHANNEL_ID,
      "https://api.sample-provider.net/start",
      undefined,
      NOW,
      budget,
      fetcher,
    )).rejects.toThrow("API source invocation request limit reached");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(budget.count()).toBe(3);
  });

  it("enforces the per-channel hourly quota atomically", async () => {
    const database = await createDatabase();
    await insertChannel(database, "another-channel");
    const db = database as unknown as D1Database;

    expect(await claimApiSourceQuota(db, CHANNEL_ID, NOW, 2)).toBe(true);
    expect(await claimApiSourceQuota(db, CHANNEL_ID, NOW + 1_000, 2)).toBe(true);
    expect(await claimApiSourceQuota(db, CHANNEL_ID, NOW + 2_000, 2)).toBe(false);
    expect(await claimApiSourceQuota(db, "another-channel", NOW, 2)).toBe(true);
  });
});

describe("API source JSONata", () => {
  it("accepts a table of allowlisted syntax and renders sunset and USD-to-EUR examples", async () => {
    const allowedExamples = [
      "$.profile.name",
      "$.items[0]",
      "'text'",
      "42",
      "true",
      "null",
      "1 + 2",
      "1 - 2",
      "2 * 3",
      "4 / 2",
      "5 % 2",
      "1 = 1",
      "1 != 2",
      "1 < 2",
      "1 <= 2",
      "2 > 1",
      "2 >= 2",
      "true and false",
      "true or false",
      "'api' & ' source'",
      "$.enabled ? 'yes' : 'no'",
      "$string($.value)",
      "$number($.value)",
      "$boolean($.value)",
      "$not($.enabled)",
      "$exists($.value)",
      "$length($.value)",
      "$substring($.value, 1, 2)",
      "$substringBefore($.value, '-')",
      "$substringAfter($.value, '-')",
      "$uppercase($.value)",
      "$lowercase($.value)",
      "$trim($.value)",
      "$contains($.value, 'x')",
      "$join($.items, ',')",
      "$sum($.items)",
      "$max($.items)",
      "$min($.items)",
      "$average($.items)",
      "$count($.items)",
      "$round($.value)",
      "$floor($.value)",
      "$ceil($.value)",
      "$abs($.value)",
      "$formatNumber($.rates.EUR * $.amount, '#,##0.00')",
      "$fromMillis(0, '[H01]:[m01]')",
      "$toMillis($.value)",
      "$now()",
      "$split($.value, ',')",
      "$replace($.text, 'old', 'new', 2)",
    ];
    for (const expression of allowedExamples) {
      expect(validateJsonataExpression(expression), expression).toBe(true);
    }

    const payload = {
      rates: { USD: 1, EUR: 0.92 },
      amount: 100,
      sunset: "2099-06-21T18:42:00.000Z",
    };
    await expect(evaluateApiSourceExpression("$.rates.USD / $.rates.EUR", payload)).resolves.toBeCloseTo(1.0869565);
    await expect(evaluateApiSourceExpression("$fromMillis($toMillis($.sunset), '[H01]:[m01]')", payload)).resolves.toBe("18:42");
    await expect(evaluateApiSourceExpression("$formatNumber($.rates.EUR * $.amount, '#,##0.00') & ' EUR'", payload)).resolves.toBe("92.00 EUR");
    await expect(evaluateApiSourceExpression("$.rates.USD > $.rates.EUR", payload)).resolves.toBe(true);
    expect(JSONATA_LIMITS).toMatchObject({
      stackDepth: 64,
      maximumSequenceLength: 1_000,
      maximumAstNodes: 64,
      maximumAstDepth: 12,
    });
  });

  it("rejects regexes, unbounded functions, and response-supplied expressions on save and evaluation", async () => {
    const redosExpression = "$contains($.value, /(a+)+$/)";
    expect(validateJsonataExpression(redosExpression)).toBe(false);
    expect(inspectApiSourceExpression(redosExpression)).toEqual({ kind: "construct_not_allowed", constructName: "regex literal" });
    await expect(evaluateApiSourceExpression(redosExpression, { value: `${"a".repeat(25)}!` }))
      .rejects.toThrow("JSONata construct regex literal is not allowed");

    for (const expression of ["$pad('x', 10000000)", "$eval($.expr)"]) {
      expect(validateJsonataExpression(expression)).toBe(false);
      await expect(evaluateApiSourceExpression(expression, { expr: "x".repeat(5_001) }))
        .rejects.toThrow("is not allowed");
    }
    const aliasedDisallowedFunction = "($join := $pad; $join('x', 10000000))";
    expect(inspectApiSourceExpression(aliasedDisallowedFunction)).toEqual({ kind: "construct_not_allowed", constructName: "block expression" });
    await expect(evaluateApiSourceExpression(aliasedDisallowedFunction, {})).rejects.toThrow("JSONata construct block expression is not allowed");
    expect(apiSourcePanelTexts("de").constructNotAllowed("$eval")).toBe("Das JSONata-Konstrukt $eval ist nicht erlaubt.");
    expect(apiSourcePanelTexts("en").constructNotAllowed("$eval")).toBe("The JSONata construct $eval is not allowed.");
  });

  it("rejects function-reference predicates, nested constructors, and range predicates", async () => {
    const rejectedExpressions = [
      '$join[$pad("x",100000)](["x"])',
      '$join[$eval("true")]( ["x"] )',
      '$join[function($x) {$x}]( ["x"] )',
      '$join[/x/]( ["x"] )',
      "$" + ".[[$,$]]".repeat(20),
      "$.items[[1..100]][[1..100]][[1..100]][[1..100]]",
      "$.items[$.position]",
      "$.items[*]",
      "$.items.**",
      "$.items^(>value)",
      "$.items{key: value}",
    ];
    for (const expression of rejectedExpressions) {
      expect(validateJsonataExpression(expression), expression).toBe(false);
      await expect(evaluateApiSourceExpression(expression, { items: Array.from({ length: 100 }, (_, index) => index) }))
        .rejects.toThrow("JSONata construct");
    }
    expect(inspectApiSourceExpression('$join[$pad("x",100000)](["x"])')).toEqual({
      kind: "construct_not_allowed",
      constructName: "$join predicate",
    });
  });

  it("rejects deterministic random nestings of disallowed AST constructs", () => {
    const wrappers = [
      (expression: string) => `[${expression}]`,
      (expression: string) => `{"value": ${expression}}`,
      (expression: string) => `function($item) { ${expression} }`,
      (expression: string) => `($temp := ${expression}; $temp)`,
      (expression: string) => `$join[${expression}](['x'])`,
      (expression: string) => `$.items[${expression}]`,
      (expression: string) => `(${expression} ~> $string)`,
      (expression: string) => `$.items{key: ${expression}}`,
    ];
    let seed = 0x2860013;
    const next = (maximum: number): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed % maximum;
    };

    for (let sample = 0; sample < 100; sample += 1) {
      let expression = "'leaf'";
      const depth = 1 + next(5);
      for (let level = 0; level < depth; level += 1) expression = wrappers[next(wrappers.length)]?.(expression) ?? expression;
      expect(validateJsonataExpression(expression), expression).toBe(false);
    }
  });

  it("caps JSONata input and string output while join and replace build their result", async () => {
    await expect(evaluateApiSourceExpression("$", { value: "x".repeat(JSONATA_LIMITS.maximumInputBytes) }))
      .rejects.toThrow("evaluation limits");
    await expect(evaluateApiSourceExpression("$join($.parts, ',')", { parts: ["x".repeat(3_000), "y".repeat(3_000)] }))
      .resolves.toHaveLength(2_000);
    await expect(evaluateApiSourceExpression("$join($.parts, ',')", { parts: ["alpha", "beta"] })).resolves.toBe("alpha,beta");
    await expect(evaluateApiSourceExpression("$split($.value, '')", { value: "x".repeat(2_000) }))
      .resolves.toHaveLength(JSONATA_LIMITS.maximumSequenceLength);
    await expect(evaluateApiSourceExpression(
      "$replace($.value, 'x', $.replacement, 10)",
      { value: "x".repeat(20), replacement: "y".repeat(3_000) },
    )).resolves.toHaveLength(2_000);
    expect(validateJsonataExpression("$replace($.value, 'x', 'y')")).toBe(false);
  });

  it("rejects hostile pictures and finishes overflow, date, and format cases quickly", async () => {
    const expectFast = async (operation: () => Promise<unknown>): Promise<void> => {
      const started = performance.now();
      await operation();
      expect(performance.now() - started).toBeLessThan(1_000);
    };

    const overflow = "$formatNumber($.a * $.b, '#,##0.00')";
    expect(validateJsonataExpression(overflow)).toBe(true);
    await expectFast(() => expect(evaluateApiSourceExpression(overflow, { a: 1e308, b: 10 }))
      .rejects.toThrow("non-finite number"));
    expect(validateJsonataExpression("$formatNumber($.a * $.b, '0e0')")).toBe(false);

    const backtrackingPicture = "$toMillis($.text, '[Mn][Mn][Mn][Mn][Mn][Mn]')";
    expect(validateJsonataExpression(backtrackingPicture)).toBe(false);
    await expectFast(() => expect(evaluateApiSourceExpression(backtrackingPicture, {
      text: `${"A".repeat(80)}1`,
    })).rejects.toThrow("JSONata construct"));
    await expectFast(() => expect(evaluateApiSourceExpression("$toMillis($.text)", {
      text: `${"A".repeat(80)}1`,
    })).rejects.toThrow("ISO-8601 UTC timestamp"));

    const suppliedPicture = "$formatNumber($.amount, $.picture)";
    expect(validateJsonataExpression(suppliedPicture)).toBe(false);
    await expectFast(() => expect(evaluateApiSourceExpression(suppliedPicture, {
      amount: 1,
      picture: `#,${"#".repeat(24_000)}`,
    })).rejects.toThrow("JSONata construct"));
    expect(validateJsonataExpression("$formatNumber($.amount, '0', $.options)")).toBe(false);
  });

  it("requires static approved format pictures and keeps date parsing ISO-only", async () => {
    const rejected = [
      "$formatNumber($.amount, $.picture)",
      "$formatNumber($.amount, '0e0')",
      "$formatNumber($.amount, '0', $.options)",
      "$fromMillis($.timestamp, $.picture)",
      "$fromMillis($.timestamp, '[Mn][Mn][Mn][Mn][Mn][Mn]')",
      "$toMillis($.timestamp, '[Y0001]-[M01]-[D01]')",
    ];
    for (const expression of rejected) {
      expect(validateJsonataExpression(expression), expression).toBe(false);
      await expect(evaluateApiSourceExpression(expression, { amount: 2, timestamp: 0, picture: "0" }))
        .rejects.toThrow("JSONata construct");
    }
    await expect(evaluateApiSourceExpression("$formatNumber(0.92, '0%')", {})).resolves.toBe("92%");
    await expect(evaluateApiSourceExpression("$fromMillis($toMillis($.timestamp))", {
      timestamp: "2099-06-21T18:42:00.000Z",
    })).resolves.toBe("2099-06-21T18:42:00.000Z");
  });

  it("rejects inputs deeper than the JSONata input-depth limit", async () => {
    let input: unknown = "leaf";
    for (let depth = 0; depth < JSONATA_LIMITS.maximumInputDepth + 1; depth += 1) input = { child: input };
    await expect(evaluateApiSourceExpression("$", input)).rejects.toThrow("evaluation limits");
  });

  it("rejects higher-order functions, lambdas, and recursive function definitions", async () => {
    const nestedMap = "$sum($map($.values, function($a) {$a}))";
    const recursive = "($loop := function($n) { $n + $loop($n + 1) }; $loop(0))";
    expect(validateJsonataExpression(nestedMap)).toBe(false);
    expect(validateJsonataExpression(recursive)).toBe(false);
    await expect(evaluateApiSourceExpression(nestedMap, { values: [1, 2, 3] })).rejects.toThrow("$map is not allowed");
    await expect(evaluateApiSourceExpression(recursive, {})).rejects.toThrow("not allowed");
  });

  it("classifies every allowlisted function as either an own implementation or an explicitly reviewed safe builtin", () => {
    expect(OWN_IMPLEMENTATION_FUNCTIONS.size + SAFE_BUILTIN_FUNCTIONS.size).toBe(ALLOWED_FUNCTIONS.size);
    for (const name of ALLOWED_FUNCTIONS) {
      const isOwn = OWN_IMPLEMENTATION_FUNCTIONS.has(name);
      const isSafeBuiltin = SAFE_BUILTIN_FUNCTIONS.has(name);
      expect(isOwn || isSafeBuiltin, `$${name} must be classified as own implementation or safe builtin`).toBe(true);
      expect(isOwn && isSafeBuiltin, `$${name} must not be in both classification sets`).toBe(false);
    }
    for (const name of OWN_IMPLEMENTATION_FUNCTIONS) expect(ALLOWED_FUNCTIONS.has(name), `$${name}`).toBe(true);
    for (const name of SAFE_BUILTIN_FUNCTIONS) expect(ALLOWED_FUNCTIONS.has(name), `$${name}`).toBe(true);
  });

  it("rejects $now with any argument, including a picture that would blow up JSONata's date formatter", async () => {
    const hostilePicture = "$now($.picture)";
    expect(validateJsonataExpression(hostilePicture)).toBe(false);
    expect(inspectApiSourceExpression(hostilePicture)).toEqual({
      kind: "construct_not_allowed",
      constructName: "$now (zero arguments only)",
    });
    await expect(evaluateApiSourceExpression(hostilePicture, { picture: "[Y0001,1000000]" }))
      .rejects.toThrow("JSONata construct $now (zero arguments only) is not allowed");
    expect(validateJsonataExpression("$now('[H01]:[m01]')")).toBe(false);
  });

  it("evaluates $now with zero arguments through its own bounded implementation, not JSONata's date formatter", async () => {
    const started = performance.now();
    const result = await evaluateApiSourceExpression("$now()", {});
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((result as string).length).toBeLessThanOrEqual(24);
  });

  it.each([
    ["$boolean", "$boolean($.items)"],
    ["$not", "$not($.enabled)"],
    ["$exists", "$exists($.items)"],
  ])("finishes %s fast on a large-but-capped input and returns a bounded boolean", async (_name, expression) => {
    const started = performance.now();
    const result = await evaluateApiSourceExpression(expression, {
      items: Array.from({ length: 8_000 }, (_, index) => index % 2 === 0),
      enabled: true,
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(typeof result).toBe("boolean");
  });
});

describe("API source Node-side template CPU measurement", () => {
  it("measures nested blocks, two data conditions, and three JSONata expressions in Node", async () => {
    const database = await createDatabase();
    const db = database as unknown as D1Database;
    await insertSource(database, "sunset", "$fromMillis($toMillis($.sunset), '[H01]:[m01]')", "https://api.sample-provider.net/daily");
    await insertSource(database, "sunset_condition", "$.sunset != ''", "https://api.sample-provider.net/sunset-condition");
    await insertSource(database, "rates_condition", "$.rates.USD > $.rates.EUR", "https://api.sample-provider.net/rates-condition");
    await database.prepare(
      `INSERT INTO text_library_categories (channel_id, category_id, catalog_key, custom_name, created_at, updated_at)
       VALUES (?, 'info', 'info', NULL, ?, ?)`,
    ).bind(CHANNEL_ID, new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();
    const blockNames = ["root", "level_one", "level_two"] as const;
    const blockTexts = ["{level_one}", "{level_two}", "{api_source.value sunset}"] as const;
    for (const [index, name] of blockNames.entries()) {
      await database.prepare(
        `INSERT INTO text_blocks (channel_id, block_name, category_id, games_json, revision, created_at, updated_at)
         VALUES (?, ?, 'info', '[]', 1, ?, ?)`,
      ).bind(CHANNEL_ID, name, new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();
      await database.prepare(
        `INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
         VALUES (?, ?, 'default', 0, ?, ?)`,
      ).bind(
        CHANNEL_ID,
        name,
        index === 2
          ? JSON.stringify({ data: { "api_source.sunset_condition": "true", "api_source.rates_condition": "true" } })
          : "{}",
        JSON.stringify([blockTexts[index]]),
      ).run();
    }

    const payload = {
      sunset: "2099-06-21T18:42:00.000Z",
      rates: { USD: 1, EUR: 0.92 },
      values: Array.from({ length: 6_000 }, (_, index) => index + 1),
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse(payload, { "Cache-Control": "max-age=60" })));
    vi.stubGlobal("fetch", fetcher);
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.chat.message",
      triggerId: "api-source-benchmark",
      payload: { broadcaster_user_login: "benchmark" },
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: { userId: "benchmark-viewer", login: "viewer", role: null },
      chatStatus: ["viewer"],
    };
    const conditions = await apiSourceModule.textBlockConditionsForChannel?.(db, CHANNEL_ID) ?? [];
    const budget = sharedBudget();
    const templateValueProviders: NonNullable<TemplateResolverSources["templateValueProviders"]> = [
      {
        moduleId: textLibraryModule.id,
        templateVariableNamespace: "text_blocks",
        variables: [],
        resolveTemplateValues: (names, context) => createTextBlockTemplateValueProvider(db, CHANNEL_ID)(names, context),
      },
      {
        moduleId: apiSourceModule.id,
        variables: [API_SOURCE_VALUE_VARIABLE],
        textBlockConditions: conditions,
        templateUnavailableText: { de: "nicht verfügbar", en: "unavailable" },
        resolveTemplateParameter: (name, parameter, context) => apiSourceModule.resolveTemplateParameter?.(name, parameter, context) ?? Promise.resolve(null),
        resolveTemplateConditions: (ids, context) => apiSourceModule.resolveTemplateConditions?.(ids, context) ?? Promise.resolve({}),
      },
    ];
    const sources: TemplateResolverSources = {
      DB: db,
      publicOrigin: "https://brobot.esembe.app",
      externalFetchBudget: budget,
      channelInfo: () => Promise.resolve(null),
      channelGameId: () => Promise.resolve(null),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve(null),
      templateValueProviders,
      registeredTemplateVariables: [API_SOURCE_VALUE_VARIABLE],
      streamState: () => Promise.resolve("offline"),
      channelDetails: () => Promise.resolve(null),
      streamDetails: () => Promise.resolve(null),
      followedAt: () => Promise.resolve("unavailable"),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
      channelLanguage: () => Promise.resolve("en"),
      readChannelVariables: () => Promise.resolve({}),
      now: () => NOW,
    };

    const cpuMeasurementsMs: number[] = [];
    const elapsedMeasurementsMs: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      const startedCpu = process.threadCpuUsage();
      const result = await createTemplateRenderer(event, "event", [], sources)("{root}", {}, undefined, "preview");
      const cpuUsage = process.threadCpuUsage(startedCpu);
      cpuMeasurementsMs.push((cpuUsage.user + cpuUsage.system) / 1_000);
      elapsedMeasurementsMs.push(performance.now() - startedAt);
      expect(result.text).toBe("18:42");
    }
    const maximumCpuMs = Math.max(...cpuMeasurementsMs);
    const maximumElapsedMs = Math.max(...elapsedMeasurementsMs);
    console.info(`Node-side API source template CPU measurement (not a Workers guarantee): max=${maximumCpuMs.toFixed(3)} ms; elapsed=${maximumElapsedMs.toFixed(3)} ms across ${String(cpuMeasurementsMs.length)} runs`);
    expect(Number.isFinite(maximumCpuMs)).toBe(true);
    expect(budget.count()).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("evaluates each source-expression pair once and caps new evaluations at ten per render", async () => {
    const database = await createDatabase();
    const db = database as unknown as D1Database;
    for (let index = 0; index < 11; index += 1) {
      await insertSource(database, `source_${String(index)}`, "$.value", "https://api.sample-provider.net/repeated");
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ value: "payload" }, { "Cache-Control": "max-age=60" }));
    vi.stubGlobal("fetch", fetcher);
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.chat.message",
      triggerId: "api-source-evaluation-budget",
      payload: { broadcaster_user_login: "benchmark" },
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: { userId: "benchmark-viewer", login: "viewer", role: null },
      chatStatus: ["viewer"],
    };
    const budget = sharedBudget();
    const sources: TemplateResolverSources = {
      DB: db,
      publicOrigin: "https://brobot.esembe.app",
      externalFetchBudget: budget,
      channelInfo: () => Promise.resolve(null),
      channelGameId: () => Promise.resolve(null),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve(null),
      templateValueProviders: [{
        moduleId: apiSourceModule.id,
        variables: [API_SOURCE_VALUE_VARIABLE],
        templateUnavailableText: { de: "nicht verfügbar", en: "unavailable" },
        resolveTemplateParameter: (name, parameter, context) =>
          apiSourceModule.resolveTemplateParameter?.(name, parameter, context) ?? Promise.resolve(null),
      }],
      registeredTemplateVariables: [API_SOURCE_VALUE_VARIABLE],
      streamState: () => Promise.resolve("offline"),
      channelDetails: () => Promise.resolve(null),
      streamDetails: () => Promise.resolve(null),
      followedAt: () => Promise.resolve("unavailable"),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
      channelLanguage: () => Promise.resolve("en"),
      readChannelVariables: () => Promise.resolve({}),
      now: () => NOW,
    };
    const placeholders = [
      ...Array.from({ length: 11 }, () => "{api_source.value source_0}"),
      ...Array.from({ length: 10 }, (_, index) => `{api_source.value source_${String(index + 1)}}`),
    ];

    const result = await createTemplateRenderer(event, "event", [], sources)(placeholders.join("|"), {}, undefined, "preview");

    expect(result.text.split("payload")).toHaveLength(21);
    expect(result.text).toContain("unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(budget.count()).toBe(1);
  });
});
