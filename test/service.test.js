import test from "node:test";
import assert from "node:assert/strict";
import { createConnectorService } from "../src/service.js";

const companyId = "company-1";
const bot = { agentId: "agent-1", botUserId: "bot-user-1", botUsername: "analyst", token: { type: "secret_ref", secretId: "secret-1" } };
const config = { companyId, mattermostBaseUrl: "https://mattermost.example", channelIds: ["channel-1"], allowedUserIds: ["user-1"], bots: [bot] };
const agent = { id: "agent-1", name: "Аналитик", status: "idle" };
const userPost = { id: "post-1", channel_id: "channel-1", user_id: "user-1", message: "@analyst Подготовь отчет" };

function makeHarness({ agents = [agent], existingIssues = [], issueStatus = "todo", comments = [], pollSince, channelIds = config.channelIds, financeAgentId, bots = [bot], listAgentsImpl } = {}) {
  const serviceConfig = { ...config, channelIds, financeAgentId, bots: bots.map((entry) => ({ ...entry, ...(pollSince === undefined ? {} : { pollSince }) })) };
  const state = new Map([["mattermost-cursor:channel-1:agent-1", "cursor-0"]]);
  const issues = [...existingIssues];
  const sent = new Map();
  const sessions = new Map();
  const callbacks = [];
  const counters = { creates: 0, wakeups: 0, listAgents: 0, postCalls: 0, issueGets: 0, issueLists: 0, tokenResolutions: 0, clientCreations: 0, sessionCreates: 0, sessionLists: 0, sessionSends: 0 };
  const ctx = {
    agents: {
      async list() { counters.listAgents += 1; return listAgentsImpl ? listAgentsImpl() : agents; },
      sessions: {
        async list(agentId) { counters.sessionLists += 1; return [...sessions.values()].filter((session) => session.agentId === agentId); },
        async create(agentId, selectedCompanyId, options) {
          counters.sessionCreates += 1;
          const session = { sessionId: `session-${counters.sessionCreates}`, companyId: selectedCompanyId, agentId, status: "active", taskKey: options.taskKey };
          sessions.set(session.sessionId, session);
          return session;
        },
        async sendMessage(sessionId, _selectedCompanyId, options) {
          counters.sessionSends += 1;
          callbacks.push({ sessionId, prompt: options.prompt, onEvent: options.onEvent });
          return { runId: `run-${counters.sessionSends}` };
        }
      }
    },
    state: {
      async get({ stateKey }) { return state.get(stateKey) ?? null; },
      async set({ stateKey }, value) { state.set(stateKey, value); }
    },
    issues: {
      async list(filter) {
        counters.issueLists += 1;
        if (filter.originId) return issues.filter((item) => item.originId === filter.originId);
        return issues.filter((item) => item.originKind === filter.originKind).slice(filter.offset, filter.offset + filter.limit);
      },
      async get(issueId) {
        counters.issueGets += 1;
        return issues.find((item) => item.id === issueId) ?? null;
      },
      async create(input) {
        counters.creates += 1;
        const issue = { ...input, id: `issue-${counters.creates}`, identifier: `CAT-${counters.creates}`, status: issueStatus };
        issues.push(issue);
        return issue;
      },
      async requestWakeup() { counters.wakeups += 1; return { queued: true }; },
      async listComments() { return comments; }
    }
  };
  const statuses = [];
  const client = {
    async setPostStatus(postId, status) { statuses.push({ postId, status }); },
    async latestPostId() { return "cursor-0"; },
    async postsAfter() { return { posts: [userPost], hasNext: false }; },
    async postsSince() { return []; },
    async getThread(rootId) { return { posts: Object.fromEntries((sent.get(rootId) ?? []).map((post, index) => [`sent-${index}`, post])) }; },
    async createReply(reply) {
      counters.postCalls += 1;
      const posts = sent.get(reply.rootId) ?? [];
      posts.push({ id: `sent-${counters.postCalls}`, create_at: counters.postCalls, user_id: serviceConfig.bots.find((entry) => entry.agentId === reply.agentId)?.botUserId ?? bot.botUserId, props: { paperclip_delivery_key: reply.deliveryKey, paperclip_issue_id: reply.issueId, ...(reply.agentId ? { paperclip_agent_id: reply.agentId } : {}) }, message: reply.text });
      sent.set(reply.rootId, posts);
      return {};
    }
  };
  const service = createConnectorService({
    ctx,
    config: serviceConfig,
    resolveToken: async () => { counters.tokenResolutions += 1; return "opaque-secret"; },
    clientFactory: () => { counters.clientCreations += 1; return client; }
  });
  return { service, issues, sent, state, counters, client, callbacks, sessions, statuses };
}

test("unauthorized channel and user posts never create Paperclip issues", async () => {
  const h = makeHarness();
  await h.service.dispatchPost(bot, { ...userPost, channel_id: "other-channel" });
  await h.service.dispatchPost(bot, { ...userPost, id: "post-2", user_id: "other-user" });
  await h.service.dispatchPost(bot, { ...userPost, message: "just a message" });
  assert.equal(h.counters.creates, 0);
  assert.equal(h.counters.tokenResolutions, 0);
});

test("a message arriving after an initially empty channel is not skipped", async () => {
  const h = makeHarness();
  h.state.delete("mattermost-cursor:channel-1:agent-1");
  h.client.latestPostId = async () => null;
  h.client.postsSince = async () => [userPost];
  await h.service.pollAndReconcile();
  assert.match(h.state.get("mattermost-cursor:channel-1:agent-1"), /^since:/);
  await h.service.pollAndReconcile();
  assert.equal(h.counters.creates, 1);
});

test("agent roster discovers newly created Paperclip agents on demand", async () => {
  const newAgent = { id: "agent-new", name: "Новый сотрудник", status: "idle" };
  const h = makeHarness({ agents: [agent, newAgent] });
  await h.service.dispatchPost(bot, { ...userPost, message: "@analyst агенты" });
  assert.equal(h.counters.listAgents, 1);
  assert.match(h.sent.get("post-1")[0].message, /Новый сотрудник/);
  assert.match(h.sent.get("post-1")[0].message, /бот еще не подключен/);
});

test("a duplicate post after restart reuses its stable origin and does not duplicate the receipt", async () => {
  const h = makeHarness();
  await h.service.pollAndReconcile();
  await h.service.pollAndReconcile();
  assert.equal(h.counters.creates, 1);
  assert.equal(h.counters.wakeups, 2);
  assert.equal(h.sent.get("post-1").filter((post) => post.props.paperclip_delivery_key === "receipt:issue-1").length, 1);
});

test("a completed task comment is posted once in the original Mattermost thread", async () => {
  const issue = { id: "issue-1", companyId, originKind: "plugin:catacode.paperclip-mattermost:post", originId: "channel-1:post-1", status: "done", assigneeAgentId: "agent-1" };
  const h = makeHarness({ existingIssues: [issue], comments: [{ authorAgentId: "agent-1", body: "Готовый результат" }] });
  await Promise.all([h.service.reconcileIssues(), h.service.reconcileIssues(), h.service.pollAndReconcile()]);
  const replies = h.sent.get("post-1");
  const results = replies.filter((post) => post.props.paperclip_delivery_key === "result:issue-1");
  assert.equal(results.length, 1);
  assert.equal(results[0].message, "Готовый результат");
  // One resolution serves the recovery poll across all channels, one serves
  // the immediate result post. The concurrent event and poll still deduplicate.
  assert.equal(h.counters.tokenResolutions, 2);
});

test("event reconciliation reads one issue while scheduled recovery scans the durable plugin issues", async () => {
  const issue = { id: "issue-1", companyId, originKind: "plugin:catacode.paperclip-mattermost:post", originId: "channel-1:post-1", status: "done", assigneeAgentId: "agent-1" };
  const h = makeHarness({ existingIssues: [issue], comments: [{ authorAgentId: "agent-1", body: "Готовый результат" }] });
  await h.service.reconcileIssues("issue-1");
  assert.equal(h.counters.issueGets, 1);
  assert.equal(h.counters.issueLists, 0);
  assert.equal(h.sent.get("post-1").length, 1);
});

test("a new profile cursor starts at bot creation and catches its first post without replaying older history", async () => {
  const h = makeHarness({ pollSince: 100 });
  h.state.delete("mattermost-cursor:channel-1:agent-1");
  await h.service.initializeCursors();
  assert.equal(h.state.get("mattermost-cursor:channel-1:agent-1"), "since:100");
  let latestCalls = 0;
  h.client.latestPostId = async () => { latestCalls += 1; return "oldest"; };
  h.client.postsSince = async (_channelId, timestamp) => {
    assert.equal(timestamp, 100);
    return [{ ...userPost, id: "first-after-profile", create_at: 101, message: "@analyst задача: new hire first task" }];
  };
  await h.service.pollAndReconcile();
  assert.equal(latestCalls, 0);
  assert.deepEqual(h.issues.map((item) => item.title), ["new hire first task"]);
});

test("malformed mention gets usage guidance instead of creating an issue", async () => {
  const h = makeHarness();
  await h.service.dispatchPost(bot, { ...userPost, message: "@analyst" });
  assert.equal(h.counters.creates, 0);
  assert.match(h.sent.get("post-1")[0].message, /Формат:/);
});

test("natural bot mention routes by stable agent id after agent rename", async () => {
  const renamed = { ...agent, name: "Финансовый аналитик" };
  const h = makeHarness({ agents: [renamed] });
  const result = await h.service.dispatchPost(bot, { ...userPost, message: "@analyst Подготовь отчет" });
  assert.equal(result.agent.id, bot.agentId);
  assert.equal(result.issue.assigneeAgentId, "agent-1");
  assert.match(result.issue.description, /Финансовый аналитик/);
  assert.match(result.issue.description, /Автор сообщения Mattermost: user-1/);
});

test("Mattermost markup in the task title is escaped as literal issue data", async () => {
  const h = makeHarness();
  const result = await h.service.dispatchPost(bot, { ...userPost, message: "@analyst задача: [опасная ссылка](https://example.invalid) остальной текст" });
  assert.equal(result.issue.title, "\\[опасная ссылка\\]\\(https://example.invalid\\) остальной текст");
});

test("a paused Paperclip agent cannot receive a new Mattermost task", async () => {
  const h = makeHarness({ agents: [{ ...agent, status: "paused" }] });
  const result = await h.service.dispatchPost(bot, { ...userPost, message: "@analyst задача: test paused routing" });
  assert.equal(result.kind, "unknown-agent");
  assert.equal(h.counters.creates, 0);
});

test("an agent with failed last run but ready lifecycle accepts a retry task", async () => {
  const failedRunAgent = { ...agent, status: "error", lifecycleState: "ready" };
  const h = makeHarness({ agents: [failedRunAgent] });
  const result = await h.service.dispatchPost(bot, { ...userPost, message: "@analyst задача: Повтори проверку" });
  assert.equal(result.kind, "task");
  assert.equal(result.issue.assigneeAgentId, agent.id);
  assert.equal(h.counters.creates, 1);
  assert.equal(h.counters.wakeups, 1);
});

test("WebSocket dispatch applies channel, user, and bot gates and recovery polling deduplicates", async () => {
  const h = makeHarness();
  const denied = await h.service.dispatchPost(bot, { ...userPost, channel_id: "other-channel" });
  assert.equal(denied, null);
  await h.service.dispatchPost(bot, userPost);
  await h.service.pollAndReconcile();
  assert.equal(h.counters.creates, 1);
  assert.equal(h.sent.get("post-1").filter((post) => post.props.paperclip_delivery_key === "receipt:issue-1").length, 1);
});

test("polling reuses one resolved bot client across all configured channels", async () => {
  const channels = ["channel-1", "channel-2", "channel-3", "channel-4"];
  const h = makeHarness({ channelIds: channels });
  await h.service.pollAndReconcile();
  assert.equal(h.counters.tokenResolutions, 1);
  assert.equal(h.counters.clientCreations, 1);
});

test("recovery combines paginated Mattermost results before advancing the durable cursor", async () => {
  const h = makeHarness();
  h.client.postsAfter = async (_channelId, _anchor, page) => page === 0
    ? { posts: [
      { ...userPost, id: "post-new", create_at: 30, message: "@analyst задача: newer" },
      { ...userPost, id: "post-mid", create_at: 20, message: "@analyst задача: middle" }
    ], hasNext: true }
    : { posts: [{ ...userPost, id: "post-old", create_at: 10, message: "@analyst задача: older" }], hasNext: false };
  await h.service.pollAndReconcile();
  assert.deepEqual(h.issues.map((issue) => issue.title), ["older", "middle", "newer"]);
  assert.equal(h.state.get("mattermost-cursor:channel-1:agent-1"), "post-new");
});

test("questions use a durable native session, send the canonical answer, and continue in an established thread", async () => {
  const h = makeHarness();
  const question = { ...userPost, message: "@analyst вопрос: Как устроен процесс?" };
  await h.service.dispatchPost(bot, question);
  assert.equal(h.counters.creates, 0);
  assert.equal(h.counters.sessionCreates, 1);
  assert.match(h.callbacks[0].prompt, /консультационный ответ/);
  await new Promise((resolve) => setImmediate(() => {
    h.callbacks[0].onEvent({ eventType: "done", message: "Канонический ответ" });
    h.callbacks[0].onEvent({ eventType: "done", message: "Дублированное событие" });
    resolve();
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.get(question.id)[0].message, "Канонический ответ");
  assert.equal(h.sent.get(question.id).length, 1);

  await h.service.dispatchPost(bot, { id: "follow-up", channel_id: question.channel_id, root_id: question.id, user_id: question.user_id, message: "А подробнее?" });
  assert.equal(h.counters.creates, 0);
  assert.equal(h.counters.sessionCreates, 1);
  assert.equal(h.counters.sessionSends, 2);
});

test("edited post adding a task mention creates one task, while duplicate edits and bot posts are ignored", async () => {
  const h = makeHarness();
  const edited = { ...userPost, message: "@analyst задача: Проверь расчет", paperclipEvent: "post_edited" };
  await h.service.dispatchPost(bot, { ...userPost, message: "начальный текст" });
  assert.equal(h.counters.creates, 0);
  await h.service.dispatchPost(bot, edited);
  await h.service.dispatchPost(bot, edited);
  await h.service.dispatchPost(bot, { ...edited, id: "bot-post", user_id: bot.botUserId });
  assert.equal(h.counters.creates, 1);
  assert.equal(h.counters.wakeups, 1);
});

test("configured finance agent receives new tasks first with estimate requirements and final target", async () => {
  const finance = { id: "finance-1", name: "Финансовый агент", status: "idle" };
  const h = makeHarness({ agents: [agent, finance], financeAgentId: finance.id });
  const result = await h.service.dispatchPost(bot, { ...userPost, message: "@analyst задача: Подготовь отчет" });
  assert.equal(result.issue.assigneeAgentId, finance.id);
  assert.match(result.issue.description, /RUB 3000 за час/);
  assert.match(result.issue.description, /диапазоном часов/);
  assert.match(result.issue.description, /стоимость неизвестна/);
  assert.match(result.issue.description, /agent-1/);
  assert.match(h.sent.get("post-1")[0].message, /Сначала финансовый агент подготовит оценку/);
});

test("inactive finance agent blocks task creation, while a task to finance itself is not redirected", async () => {
  const finance = { id: "finance-1", name: "Финансовый агент", status: "idle" };
  const unavailable = makeHarness({ agents: [agent], financeAgentId: finance.id });
  assert.equal((await unavailable.service.dispatchPost(bot, { ...userPost, message: "@analyst задача: Проверь расчет" })).kind, "finance-unavailable");
  assert.equal(unavailable.counters.creates, 0);

  const selfBot = { ...bot, agentId: finance.id, botUsername: "finance" };
  const self = makeHarness({ agents: [finance], financeAgentId: finance.id, bots: [selfBot] });
  const result = await self.service.dispatchPost(selfBot, { ...userPost, message: "@finance задача: Оцени затраты" });
  assert.equal(result.issue.assigneeAgentId, finance.id);
  assert.doesNotMatch(result.issue.description, /ПРЕДВАРИТЕЛЬНАЯ ОЦЕНКА ДО ВЫПОЛНЕНИЯ/);
});

test("an unmentioned follow-up goes only to the last bot that spoke, and an explicit other bot mention wins", async () => {
  const analystBot = bot;
  const financeBot = { ...bot, agentId: "agent-2", botUserId: "bot-user-2", botUsername: "finance" };
  const analyst = agent;
  const finance = { id: "agent-2", name: "Финансы", status: "idle" };
  const h = makeHarness({ agents: [analyst, finance], bots: [analystBot, financeBot] });
  const foreign = { id: "foreign", channel_id: "channel-1", root_id: "foreign-root", user_id: "user-1", message: "Чужая ветка" };
  await Promise.all([h.service.dispatchPost(analystBot, foreign), h.service.dispatchPost(financeBot, foreign)]);
  assert.equal(h.counters.sessionSends, 0);
  const root = { ...userPost, message: "@analyst вопрос: Первая реплика?" };
  await h.service.dispatchPost(analystBot, root);
  h.callbacks[0].onEvent({ eventType: "done", message: "Ответ аналитика" });
  await new Promise((resolve) => setImmediate(resolve));

  const explicit = { id: "explicit-finance", channel_id: root.channel_id, root_id: root.id, user_id: root.user_id, message: "@finance вопрос: Ответь в этой ветке?" };
  await h.service.dispatchPost(analystBot, explicit);
  assert.equal(h.counters.sessionSends, 1);
  await h.service.dispatchPost(financeBot, explicit);
  assert.equal(h.counters.sessionSends, 2);
  h.callbacks[1].onEvent({ eventType: "done", message: "Ответ финансов" });
  await new Promise((resolve) => setImmediate(resolve));

  const followup = { id: "followup-last-speaker", channel_id: root.channel_id, root_id: root.id, user_id: root.user_id, message: "Продолжи" };
  await Promise.all([h.service.dispatchPost(analystBot, followup), h.service.dispatchPost(financeBot, followup)]);
  assert.equal(h.counters.sessionSends, 3);
  assert.equal(h.callbacks[2].sessionId, h.callbacks[1].sessionId);
});

test("restart recovery leaves a live session pending and reports only when the saved session is gone", async () => {
  const h = makeHarness();
  await h.service.dispatchPost(bot, { ...userPost, message: "@analyst вопрос: Долго ли ждать?" });
  await h.service.recoverQuestions();
  assert.equal(h.sent.get("post-1"), undefined);
  const session = [...h.sessions.values()][0];
  session.status = "closed";
  await h.service.recoverQuestions();
  assert.match(h.sent.get("post-1")[0].message, /после перезапуска/);
});

test("task reconciliation restores the source root and marks the final agent reply", async () => {
  const issue = { id: "issue-thread", companyId, originKind: "plugin:catacode.paperclip-mattermost:post", originId: "channel-1:reply-post", status: "done", assigneeAgentId: "agent-1" };
  const h = makeHarness({ existingIssues: [issue], comments: [{ authorAgentId: "agent-1", body: "Итог" }] });
  h.state.set("mattermost-thread:issue-thread", "root-post");
  await h.service.reconcileIssues("issue-thread");
  const [reply] = h.sent.get("root-post");
  assert.equal(reply.props.paperclip_agent_id, "agent-1");
});

test("drain waits for active thread dispatches before shutdown", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = makeHarness({ listAgentsImpl: async () => { await gate; return [agent]; } });
  const dispatch = h.service.dispatchPost(bot, userPost);
  await new Promise((resolve) => setImmediate(resolve));
  let drained = false;
  const drain = h.service.drain().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await Promise.all([dispatch, drain]);
  assert.equal(drained, true);
});

test("question receipt is visible before session startup and success follows delivery", async () => {
  const h = makeHarness();
  await h.service.dispatchPost(bot, { ...userPost, message: "@analyst вопрос: Как дела?" });
  assert.deepEqual(h.statuses, [{ postId: userPost.id, status: "processing" }]);
  h.callbacks[0].onEvent({ eventType: "done", message: "Ответ" });
  await h.service.drain();
  assert.equal(h.sent.get(userPost.id)[0].message, "Ответ");
  assert.equal(h.statuses.at(-1).status, "success");
});

test("failed questions show a warning even when the error reply is delivered", async () => {
  const h = makeHarness();
  await h.service.dispatchPost(bot, { ...userPost, message: "@analyst вопрос: Как дела?" });
  h.callbacks[0].onEvent({ eventType: "error" });
  await h.service.drain();
  assert.equal(h.statuses.at(-1).status, "error");
  assert.equal(h.state.get("mattermost-question:agent-1:post-1").outcome, "error");
});

test("a reaction outage does not prevent the accepted request or result", async () => {
  const h = makeHarness();
  h.client.setPostStatus = async () => { throw new Error("unavailable"); };
  await h.service.dispatchPost(bot, { ...userPost, message: "@analyst вопрос: Как дела?" });
  h.callbacks[0].onEvent({ eventType: "done", message: "Ответ" });
  await h.service.drain();
  assert.equal(h.sent.get(userPost.id)[0].message, "Ответ");
});

test("task completion clears processing only after a final comment is delivered", async () => {
  const comments = [];
  const h = makeHarness({ comments });
  await h.service.dispatchPost(bot, { ...userPost, message: "@analyst поисследуй варианты авторизации" });
  assert.equal(h.counters.creates, 1);
  assert.equal(h.statuses.at(-1).status, "processing");
  h.issues[0].status = "done";
  await h.service.reconcileIssues(h.issues[0].id);
  assert.equal(h.statuses.at(-1).status, "processing");
  comments.push({ authorAgentId: agent.id, body: "Результат исследования" });
  await h.service.reconcileIssues(h.issues[0].id);
  assert.equal(h.statuses.at(-1).status, "success");
  await h.service.dispatchPost(bot, { ...userPost, message: "@analyst поисследуй варианты авторизации" });
  assert.equal(h.statuses.at(-1).status, "success");
  assert.equal(h.counters.creates, 1);
});

test("delivery failure never marks success and retry delivers without rerunning the agent", async () => {
  const h = makeHarness();
  const createReply = h.client.createReply;
  h.client.createReply = async () => { throw new Error("delivery unavailable"); };
  const post = { ...userPost, message: "@analyst вопрос: Как дела?" };
  await h.service.dispatchPost(bot, post);
  h.callbacks[0].onEvent({ eventType: "done", message: "Ответ" });
  await h.service.drain();
  assert.equal(h.statuses.at(-1).status, "error");
  assert.equal(h.statuses.some((entry) => entry.status === "success"), false);
  h.client.createReply = createReply;
  await h.service.dispatchPost(bot, post);
  assert.equal(h.statuses.at(-1).status, "success");
  assert.equal(h.counters.sessionSends, 1);
});
