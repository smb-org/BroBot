import { beforeAll, describe, expect, it } from "vitest";
import { createBlitzQuestionRepository } from "../../src/modules/blitz_round/adapters/d1";
import { blitzRoundModule } from "../../src/modules/blitz_round";
import { BLITZ_STARTER_WORDS } from "../../src/modules/blitz_round/seed-words";
import { env } from "cloudflare:workers";
import { insertPointChannel, runMigrations } from "./points-test-helpers";

const db = (env as unknown as { DB: D1Database }).DB;

beforeAll(runMigrations);

describe("blitz question D1 repository", () => {
  it("seeds the German starter pool once only when the question pool is empty [protects=first enable inserts each starter word once and re-enable is idempotent; fails_when=seeding duplicates words or fills a nonempty pool; no_claim=does not verify localized panel copy]", async () => {
    const channelId = `blitz-seed-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const repository = createBlitzQuestionRepository(db);
    const now = new Date().toISOString();

    const seeded = await repository.seed(channelId, BLITZ_STARTER_WORDS, now);
    const repeated = await repository.seed(channelId, BLITZ_STARTER_WORDS, now);
    const pool = await repository.list(channelId, 1);

    expect(seeded).toBe(BLITZ_STARTER_WORDS.length);
    expect(repeated).toBe(0);
    expect(pool.total).toBe(BLITZ_STARTER_WORDS.length);
    expect(pool.questions.every((question) => question.kind === "scramble" && question.answers[0] === question.prompt)).toBe(true);
  });

  it("runs the actual enable hook idempotently [protects=module activation supplies executable seed statements with no duplicate rows; fails_when=onEnable omits seeding or repeated activation duplicates the pool; no_claim=does not test the host activation route authorization]", async () => {
    const channelId = `blitz-enable-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const context = { DB: db, now: new Date().toISOString(), actor: { userId: "fictional_owner" }, authorizeMutation: () => ({ sql: "", values: [] }) };
    const statements = await blitzRoundModule.onEnable?.(context, channelId) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    await db.batch([...statements]);
    await db.batch([...await blitzRoundModule.onEnable?.(context, channelId) ?? []]);
    expect((await createBlitzQuestionRepository(db).list(channelId, 1)).total).toBe(BLITZ_STARTER_WORDS.length);
  });

  it("re-seeds an emptied question pool with fresh question ids [protects=an empty pool receives starter questions with identities distinct from previously deleted rows; fails_when=re-seeded starter rows reuse ids that a panel deletion tombstone can still exclude; no_claim=does not exercise panel cache reconciliation or channel lifecycle]", async () => {
    const channelId = `blitz-reseed-${crypto.randomUUID()}`;
    const repository = createBlitzQuestionRepository(db);
    const context = { DB: db, now: new Date().toISOString(), actor: { userId: "fictional_owner" }, authorizeMutation: () => ({ sql: "", values: [] }) };
    await insertPointChannel(channelId);
    await db.batch([...await blitzRoundModule.onEnable?.(context, channelId) ?? []]);
    const originalPool = [
      ...(await repository.list(channelId, 1)).questions,
      ...(await repository.list(channelId, 2)).questions,
    ];

    await db.prepare("DELETE FROM blitz_questions WHERE channel_id = ?").bind(channelId).run();
    await db.batch([...await blitzRoundModule.onEnable?.(context, channelId) ?? []]);
    const reseededPool = [
      ...(await repository.list(channelId, 1)).questions,
      ...(await repository.list(channelId, 2)).questions,
    ];

    expect(originalPool).toHaveLength(BLITZ_STARTER_WORDS.length);
    expect(reseededPool).toHaveLength(BLITZ_STARTER_WORDS.length);
    expect(reseededPool.map((question) => question.prompt).sort((left, right) => left.localeCompare(right)))
      .toEqual([...BLITZ_STARTER_WORDS].sort((left, right) => left.localeCompare(right)));
    expect(reseededPool.every((question) => !originalPool.some((original) => original.id === question.id))).toBe(true);
  });

  it("removes questions with their channel and reseeds a recreated channel with fresh ids [protects=channel deletion cascades old Blitz rows and enable recreates the full starter pool with identities distinct from old rows; fails_when=old rows survive, the pool is not reseeded, or starter ids are reused; no_claim=channel lifecycle is driven by direct D1 statements rather than the Twitch channel reconciliation flow]", async () => {
    const channelId = `blitz-recreate-${crypto.randomUUID()}`;
    const repository = createBlitzQuestionRepository(db);
    const context = { DB: db, now: new Date().toISOString(), actor: { userId: "fictional_owner" }, authorizeMutation: () => ({ sql: "", values: [] }) };
    await insertPointChannel(channelId);
    await db.batch([...await blitzRoundModule.onEnable?.(context, channelId) ?? []]);
    const originalPool = [
      ...(await repository.list(channelId, 1)).questions,
      ...(await repository.list(channelId, 2)).questions,
    ];
    expect(originalPool).toHaveLength(BLITZ_STARTER_WORDS.length);

    await db.prepare("DELETE FROM channels WHERE channel_id = ?").bind(channelId).run();
    const afterDelete = await db.prepare("SELECT COUNT(*) AS count FROM blitz_questions WHERE channel_id = ?").bind(channelId).first<{ count: number }>();
    await insertPointChannel(channelId);
    await db.batch([...await blitzRoundModule.onEnable?.(context, channelId) ?? []]);

    const recreatedPool = [
      ...(await repository.list(channelId, 1)).questions,
      ...(await repository.list(channelId, 2)).questions,
    ];
    expect(afterDelete).toEqual({ count: 0 });
    expect(recreatedPool).toHaveLength(BLITZ_STARTER_WORDS.length);
    expect(recreatedPool.every((question) => !originalPool.some((original) => original.id === question.id))).toBe(true);
  });

  it("creates, edits, disables, searches, and deletes channel-owned questions [protects=question CRUD stays scoped to one channel and preserves enabled state; fails_when=updates leak across channels or disabled rows cannot be searched; no_claim=does not exercise the dashboard form]", async () => {
    const channelId = `blitz-crud-${crypto.randomUUID()}`;
    const otherChannelId = `blitz-other-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await insertPointChannel(otherChannelId);
    const repository = createBlitzQuestionRepository(db);
    const created = await repository.create(channelId, {
      kind: "quiz", prompt: "What shines at night?", answers: ["Moon", "Starlight"], enabled: true,
    }, new Date().toISOString());
    expect(created.revision).toBe(1);
    const edited = await repository.update(channelId, created.id, created.revision, {
      kind: "quiz", prompt: "What orbits Earth?", answers: ["Moon"], enabled: false,
    }, new Date().toISOString());

    expect(edited).toMatchObject({ prompt: "What orbits Earth?", enabled: false, answers: ["Moon"], revision: 2 });
    expect(await repository.get(otherChannelId, created.id)).toBeNull();
    expect((await repository.list(channelId, 1, "orbits")).questions).toHaveLength(1);
    expect(await repository.enabledCount(channelId)).toBe(0);
    expect(await repository.update(channelId, created.id, created.revision, {
      kind: "quiz", prompt: "A stale edit?", answers: ["Sun"], enabled: true,
    }, new Date().toISOString())).toBeNull();
    expect(await repository.delete(otherChannelId, created.id, 2)).toBe(false);
    expect(await repository.delete(channelId, created.id, 2)).toBe(true);
  });

  it("finds a German scramble with either umlaut case [protects=saving KÄSE makes both käse and KÄSE searches return the question; fails_when=SQLite case folding misses the lowercase umlaut query; no_claim=does not exercise dashboard search rendering]", async () => {
    const channelId = `blitz-search-umlaut-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const repository = createBlitzQuestionRepository(db);
    await repository.create(channelId, {
      kind: "scramble", prompt: "KÄSE", answers: ["KÄSE"], enabled: true,
    }, new Date().toISOString());

    expect((await repository.list(channelId, 1, "käse")).questions).toHaveLength(1);
    expect((await repository.list(channelId, 1, "KÄSE")).questions).toHaveLength(1);
  });

  it("enforces the pool cap when concurrent creates compete for the last slot [protects=the D1 insert guard limits each channel to 500 questions atomically; fails_when=both last-slot creates succeed or neither does; no_claim=does not stress distributed D1 write latency]", async () => {
    const channelId = `blitz-limit-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await db.prepare(`WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 499)
      INSERT INTO blitz_questions (channel_id, question_id, kind, prompt, answers_json, search_text, enabled, created_at, updated_at)
      SELECT ?, 'fictional-' || value, 'quiz', 'Which star?', '["Sun"]', 'which star? sun', 1, ?, ? FROM numbers`)
      .bind(channelId, "2100-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z").run();
    const repository = createBlitzQuestionRepository(db);
    const input = { kind: "quiz" as const, prompt: "Which star?", answers: ["Sun"], enabled: true };
    const attempts = await Promise.allSettled([
      repository.create(channelId, input, new Date().toISOString()),
      repository.create(channelId, input, new Date().toISOString()),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await repository.list(channelId, 1)).total).toBe(500);
  });

  it("picks null and oldest use times before recently used questions [protects=the enabled pool rotates from the least recently played row; fails_when=a newer or disabled question wins; no_claim=does not validate random tie distribution]", async () => {
    const channelId = `blitz-pick-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const repository = createBlitzQuestionRepository(db);
    const first = await repository.create(channelId, { kind: "scramble", prompt: "CLOUD", answers: ["CLOUD"], enabled: true }, "2100-01-01T00:00:00.000Z");
    const second = await repository.create(channelId, { kind: "scramble", prompt: "LANTERN", answers: ["LANTERN"], enabled: true }, "2100-01-01T00:00:00.000Z");
    await repository.markUsed(channelId, second.id, "2100-01-03T00:00:00.000Z");
    await repository.create(channelId, { kind: "scramble", prompt: "STONE", answers: ["STONE"], enabled: false }, "2100-01-01T00:00:00.000Z");

    expect((await repository.pick(channelId))?.id).toBe(first.id);
    await repository.markUsed(channelId, first.id, "2100-01-04T00:00:00.000Z");
    expect((await repository.pick(channelId))?.id).toBe(second.id);
  });
});
