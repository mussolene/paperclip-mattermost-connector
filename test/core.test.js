import test from "node:test";
import assert from "node:assert/strict";
import { activeAgents, findAgentBySlug, hasDelivery, isAllowedPost, originIdForPost, parseMentionedCommand, selectFinalComment } from "../src/core.js";
import { normalizeBaseUrl } from "../src/config.js";

test("routes questions to consultation and only explicit action requests to tasks", () => {
  assert.equal(parseMentionedCommand("please help", "masha"), null);
  assert.deepEqual(parseMentionedCommand("@masha агент:аналитик    ", "masha"), { kind: "usage" });
  assert.deepEqual(parseMentionedCommand("@masha агент:аналитик задача: Сделай отчет", "masha"), { kind: "task", slug: "аналитик", text: "Сделай отчет" });
  assert.deepEqual(parseMentionedCommand("@masha агент:аналитик вопрос: Как устроена загрузка?", "masha"), { kind: "question", slug: "аналитик", text: "Как устроена загрузка?" });
  assert.deepEqual(parseMentionedCommand("@masha Проверь расчет", "masha"), { kind: "task", slug: null, text: "Проверь расчет" });
  assert.deepEqual(parseMentionedCommand("@masha Как устроена загрузка?", "masha"), { kind: "question", slug: null, text: "Как устроена загрузка?" });
  assert.deepEqual(parseMentionedCommand("@masha привет", "masha"), { kind: "question", slug: null, text: "привет" });
  assert.deepEqual(parseMentionedCommand("@masha можно ли посмотреть?", "masha"), { kind: "question", slug: null, text: "можно ли посмотреть?" });
  assert.deepEqual(parseMentionedCommand("@masha Объясни, а потом сделай отчет", "masha"), { kind: "question", slug: null, text: "Объясни, а потом сделай отчет" });
  assert.deepEqual(parseMentionedCommand("@masha задача:", "masha"), { kind: "usage" });
  assert.deepEqual(parseMentionedCommand("@masha агенты", "masha"), { kind: "agents" });
});

test("Mattermost WebSocket extracts posted payloads and rejects unrelated events", async () => {
  const { parseMattermostSocketEvent } = await import("../src/core.js");
  const post = { id: "p1", channel_id: "c1", user_id: "u1", message: "@masha привет" };
  assert.deepEqual(parseMattermostSocketEvent(JSON.stringify({ event: "posted", data: { post: JSON.stringify(post) } })), post);
  assert.deepEqual(parseMattermostSocketEvent(JSON.stringify({ event: "post_edited", data: { post: JSON.stringify(post) } })), { ...post, paperclipEvent: "post_edited" });
  assert.equal(parseMattermostSocketEvent(JSON.stringify({ event: "typing", data: { post } })), null);
  assert.equal(parseMattermostSocketEvent("bad json"), null);
});

test("plain HTTP is opt-in and restricted to local Docker names", () => {
  assert.equal(normalizeBaseUrl("https://mm.example/"), "https://mm.example");
  assert.throws(() => normalizeBaseUrl("http://mattermost:8065"));
  assert.equal(normalizeBaseUrl("http://mattermost:8065", true), "http://mattermost:8065");
  assert.throws(() => normalizeBaseUrl("http://mm.example", true));
});

test("filters channels, users, bot messages and system posts", () => {
  const rules = { channelIds: ["channel-a"], allowedUserIds: ["user-a"], botUserIds: new Set(["bot-a"]) };
  assert.equal(isAllowedPost({ id: "1", channel_id: "channel-a", user_id: "user-a" }, rules), true);
  assert.equal(isAllowedPost({ id: "1", channel_id: "other", user_id: "user-a" }, rules), false);
  assert.equal(isAllowedPost({ id: "1", channel_id: "channel-a", user_id: "bot-a" }, rules), false);
  assert.equal(isAllowedPost({ id: "1", channel_id: "channel-a", user_id: "user-a", type: "system_join_channel" }, rules), false);
});

test("agent lookup is dynamic, unique and excludes paused agents", () => {
  const agents = [
    { id: "a1", name: "Аналитик", status: "idle" },
    { id: "a2", name: "Остановлен", status: "paused" },
    { id: "a3", name: "Аналитик", status: "running" }
  ];
  assert.equal(activeAgents(agents).length, 2);
  assert.equal(findAgentBySlug(agents, "остановлен"), null);
  assert.equal(findAgentBySlug(agents, "аналитик"), null);
  assert.equal(findAgentBySlug([{ id: "a4", name: "Новый агент", status: "idle" }], "новый-агент").id, "a4");
});

test("last-run errors remain callable only when lifecycle is ready or absent", () => {
  const agents = [
    { id: "ready-error", status: "error", lifecycleState: "ready" },
    { id: "legacy-error", status: "error" },
    { id: "paused-error", status: "error", lifecycleState: "paused" },
    { id: "verifying-error", status: "error", lifecycleState: "verifying" },
    { id: "terminated", status: "idle", lifecycleState: "terminated" },
    { id: "archived", status: "idle", lifecycleState: "archived" },
    { id: "paused", status: "paused", lifecycleState: "ready" }
  ];
  assert.deepEqual(activeAgents(agents).map((agent) => agent.id), ["ready-error", "legacy-error"]);
});

test("source identity and final comment selection support restart-safe reconciliation", () => {
  const post = { id: "post-1", channel_id: "channel-1" };
  assert.equal(originIdForPost(post), "channel-1:post-1");
  assert.equal(selectFinalComment([
    { authorAgentId: "agent-1", body: "черновик" },
    { authorAgentId: "agent-2", body: "чужой комментарий" },
    { authorAgentId: "agent-1", body: "готовый ответ" }
  ], "agent-1").body, "готовый ответ");
  assert.equal(hasDelivery({ posts: { p1: { props: { paperclip_delivery_key: "result:i1" } } } }, "result:i1"), true);
  assert.equal(hasDelivery({ posts: {} }, "result:i1"), false);
});
