import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createPluginRuntime } from "../src/runtime.js";

const config = {
  mattermostBaseUrl: "https://mm.example",
  bots: [{ agentId: "agent-1", botUserId: "bot-1", botUsername: "agent", token: { type: "secret_ref", secretId: "token-1" } }],
  channelIds: ["channel-1"],
  allowedUserIds: ["user-1"]
};

function context() {
  let registeredJob;
  const configReads = [];
  const eventHandlers = new Map();
  const eventUnsubscribes = [];
  return {
    jobs: { register(_key, handler) { registeredJob = handler; } },
    logger: { warn() {} },
    config: { async get(companyId) { configReads.push(companyId); return config; } },
    events: { on(name, filter, handler) {
      eventHandlers.set(name, { filter, handler });
      const unsubscribe = () => eventHandlers.delete(name);
      eventUnsubscribes.push(unsubscribe);
      return unsubscribe;
    } },
    secrets: { async resolve() { throw new Error("not used"); } },
    get job() { return registeredJob; },
    configReads,
    eventHandlers,
    eventUnsubscribes
  };
}

function factories() {
  const services = [];
  const socketManagers = [];
  return {
    services,
    socketManagers,
    serviceFactory() {
      const service = { polls: 0, drained: 0, recoveries: 0, async initializeCursors() {}, async recoverQuestions() { this.recoveries += 1; }, async pollAndReconcile() { this.polls += 1; }, async drain() { this.drained += 1; } };
      services.push(service);
      return service;
    },
    socketFactory() {
      const socket = { closed: false, close() { this.closed = true; }, updateBots() {}, diagnostics() { return { authenticatedSockets: 0, failureCount: 0 }; }, reportFailure() {} };
      socketManagers.push(socket);
      return socket;
    }
  };
}

test("setup registers the job without reading unscoped config; startup delivery initializes company config", async () => {
  const ctx = context();
  const factory = factories();
  const runtime = createPluginRuntime(factory);
  await runtime.setup(ctx);
  assert.deepEqual(ctx.configReads, []);
  assert.equal((await runtime.onHealth()).status, "degraded");
  await runtime.onConfigChanged(config, { companyId: "company-1" });
  assert.equal(factory.services[0].recoveries, 1);
  assert.equal((await runtime.onHealth()).status, "ok");
  await ctx.job({ companyId: "company-1" });
  assert.equal(factory.services[0].polls, 1);
});

test("a restarted worker initializes from config delivery and same-company updates drain old work", async () => {
  const factory = factories();
  const firstContext = context();
  const firstRuntime = createPluginRuntime(factory);
  await firstRuntime.setup(firstContext);
  await firstRuntime.onConfigChanged(config, { companyId: "company-1" });
  await firstContext.job({ companyId: "company-1" });

  const secondContext = context();
  const secondRuntime = createPluginRuntime(factory);
  await secondRuntime.setup(secondContext);
  await secondRuntime.onConfigChanged(config, { companyId: "company-1" });
  assert.equal((await secondRuntime.onHealth()).status, "ok");

  await firstRuntime.onConfigChanged(config, { companyId: "company-1" });
  assert.equal(factory.socketManagers[0].closed, true);
  assert.equal(factory.services[0].drained, 1);
});

test("job-scoped config recovery passes the company id and rejects cross-company runs", async () => {
  const ctx = context();
  const factory = factories();
  const runtime = createPluginRuntime(factory);
  await runtime.setup(ctx);
  await ctx.job({ companyId: "company-1" });
  assert.deepEqual(ctx.configReads, ["company-1"]);
  await assert.rejects(ctx.job({ companyId: "company-2" }), /unexpected company/);
});

test("WebSocket callbacks run outside the expired config-change invocation scope", async () => {
  const storage = new AsyncLocalStorage();
  let capturedDispatch;
  const ctx = context();
  const runtime = createPluginRuntime({
    serviceFactory() {
      return {
        dispatchPost() { return storage.getStore(); },
        async initializeCursors() {},
        async pollAndReconcile() {},
        async drain() {}
      };
    },
    socketFactory({ dispatchPost }) {
      capturedDispatch = dispatchPost;
      return { close() {}, updateBots() {}, reportFailure() {}, diagnostics() { return { authenticatedSockets: 0, failureCount: 0 }; } };
    }
  });
  await runtime.setup(ctx);
  await storage.run({ invocation: "config-change" }, () => runtime.onConfigChanged(config, { companyId: "company-1" }));
  const observed = await storage.run({ invocation: "expired-websocket" }, () => capturedDispatch({}, {}));
  assert.equal(observed, undefined);
});

test("issue completion and comment events reconcile immediately and subscriptions are disposed", async () => {
  const ctx = context();
  const factory = factories();
  let reconciles = 0;
  const runtime = createPluginRuntime({
    serviceFactory() { return { async initializeCursors() {}, async reconcileIssues() { reconciles += 1; }, async pollAndReconcile() {}, async drain() {} }; },
    socketFactory: factory.socketFactory
  });
  await runtime.setup(ctx);
  await runtime.onConfigChanged(config, { companyId: "company-1" });
  assert.deepEqual(ctx.eventHandlers.get("issue.updated").filter, { companyId: "company-1" });
  assert.deepEqual(ctx.eventHandlers.get("issue.comment.created").filter, { companyId: "company-1" });
  await ctx.eventHandlers.get("issue.updated").handler({ companyId: "other-company" });
  await ctx.eventHandlers.get("issue.updated").handler({ companyId: "company-1", entityId: "issue-1" });
  await ctx.eventHandlers.get("issue.comment.created").handler({ companyId: "company-1", entityId: "issue-1", payload: { commentId: "comment-1" } });
  assert.equal(reconciles, 2);
  await runtime.onConfigChanged(config, { companyId: "company-1" });
  assert.equal(ctx.eventHandlers.size, 2);
  await runtime.onShutdown();
  assert.equal(ctx.eventHandlers.size, 0);
});

test("invalid config never tears down a working connector or resolves credentials", async () => {
  const ctx = context();
  const factory = factories();
  const runtime = createPluginRuntime(factory);
  await runtime.setup(ctx);
  await runtime.onConfigChanged(config, { companyId: "company-1" });
  await assert.rejects(runtime.onConfigChanged({ ...config, channelIds: [] }, { companyId: "company-1" }), /channelIds/);
  assert.equal(factory.socketManagers[0].closed, false);
  assert.equal(factory.services[0].drained, 0);
  await assert.rejects(runtime.onConfigChanged({ ...config, companyId: "other-company" }, { companyId: "company-1" }), /does not match/);
});
