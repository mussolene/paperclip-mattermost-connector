import test from "node:test";
import assert from "node:assert/strict";
import { startMattermostSockets } from "../src/socket.js";

test("authenticated Mattermost WebSocket events enter the shared dispatcher", async () => {
  const listeners = new Map();
  const sent = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; }
    addEventListener(name, fn) { listeners.set(name, fn); }
    send(value) { sent.push(JSON.parse(value)); }
    close() {}
  }
  const received = [];
  const bot = { agentId: "a1", botUsername: "kirill" };
  const manager = startMattermostSockets({
    config: { companyId: "co1", mattermostBaseUrl: "https://mm.example", bots: [bot] },
    resolveToken: async () => "test-secret",
    dispatchPost: async (selectedBot, post) => received.push({ selectedBot, post }),
    WebSocketImpl: FakeWebSocket
  });
  await Promise.resolve();
  listeners.get("open")();
  assert.deepEqual(sent[0], { seq: 1, action: "authentication_challenge", data: { token: "test-secret" } });
  const post = { id: "p1", channel_id: "c1", user_id: "u1", message: "@kirill задача" };
  listeners.get("message")({ data: JSON.stringify({ event: "posted", data: { post: JSON.stringify(post) } }) });
  listeners.get("message")({ data: JSON.stringify({ event: "post_edited", data: { post: JSON.stringify({ ...post, message: "@kirill задача: новая редакция" }) } }) });
  await Promise.resolve();
  assert.deepEqual(received, [
    { selectedBot: bot, post },
    { selectedBot: bot, post: { ...post, message: "@kirill задача: новая редакция", paperclipEvent: "post_edited" } }
  ]);
  manager.close();
});
