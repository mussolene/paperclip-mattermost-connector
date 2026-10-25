import { parseMattermostSocketEvent } from "./core.js";

export function mattermostSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v4/websocket`;
  url.search = "";
  return url.toString();
}

export function startMattermostSockets({ config, resolveToken, dispatchPost, logger, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== "function") throw new Error("Для Mattermost WebSocket требуется Node.js с глобальным WebSocket");
  const sockets = new Set();
  let stopped = false;
  const retryTimers = new Set();
  const authenticated = new Set();
  const desired = new Map();
  const active = new Map();
  let failureCount = 0;

  function recordFailure(bot, reason) {
    failureCount += 1;
    logger?.warn("Mattermost connector operation failed", { agentId: bot.agentId, reason, failureCount });
  }

  function connect(bot) {
    if (stopped) return;
    const fingerprint = identity(bot);
    Promise.resolve(resolveToken(bot, config.companyId)).then((token) => {
      if (stopped || desired.get(bot.agentId)?.fingerprint !== fingerprint) return;
      const socket = new WebSocketImpl(mattermostSocketUrl(config.mattermostBaseUrl));
      const record = { bot, fingerprint, socket };
      active.set(bot.agentId, record);
      sockets.add(socket);
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        seq: 1,
        action: "authentication_challenge",
        data: { token }
      })));
      socket.addEventListener("message", (event) => {
        let frame;
        try { frame = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { return; }
        if (frame?.status === "OK" && frame.seq_reply === 1) {
          authenticated.add(socket);
          return;
        }
        if (frame?.status && frame.status !== "OK") {
          recordFailure(bot, "authentication_rejected");
          socket.close();
          return;
        }
        const post = parseMattermostSocketEvent(JSON.stringify(frame));
        if (post) void dispatchPost(bot, post).catch(() => recordFailure(bot, "post_dispatch_failed"));
      });
      const reconnect = () => {
        sockets.delete(socket);
        authenticated.delete(socket);
        if (stopped || active.get(bot.agentId) !== record) return;
        active.delete(bot.agentId);
        recordFailure(bot, "websocket_disconnected");
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          connect(bot);
        }, 3000);
        retryTimers.add(timer);
      };
      socket.addEventListener("close", reconnect, { once: true });
      socket.addEventListener("error", () => {
        recordFailure(bot, "websocket_error");
        socket.close();
      }, { once: true });
    }).catch(() => {
      if (stopped || desired.get(bot.agentId)?.fingerprint !== fingerprint) return;
      recordFailure(bot, "connection_or_secret_resolution_failed");
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        connect(bot);
      }, 3000);
      retryTimers.add(timer);
    });
  }

  function identity(bot) {
    return [bot.botUserId, bot.botUsername, bot.token?.secretId ?? bot.tokenGeneration ?? ""].join(":");
  }

  function updateBots(bots) {
    const next = new Map(bots.map((bot) => [bot.agentId, { bot, fingerprint: identity(bot) }]));
    for (const [agentId, current] of desired) {
      if (next.get(agentId)?.fingerprint === current.fingerprint) continue;
      desired.delete(agentId);
      const running = active.get(agentId);
      if (running) {
        active.delete(agentId);
        running.socket.close();
      }
    }
    for (const [agentId, current] of next) {
      if (desired.get(agentId)?.fingerprint === current.fingerprint) continue;
      desired.set(agentId, current);
      connect(current.bot);
    }
  }

  updateBots(config.bots);
  return {
    updateBots,
    reportFailure(reason) {
      failureCount += 1;
      logger?.warn("Mattermost connector operation failed", { reason, failureCount });
    },
    diagnostics() {
      return { authenticatedSockets: authenticated.size, failureCount };
    },
    close() {
      stopped = true;
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      for (const socket of sockets) socket.close();
      sockets.clear();
    }
  };
}
