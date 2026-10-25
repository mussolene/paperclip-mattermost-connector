import test from "node:test";
import assert from "node:assert/strict";
import { createMattermostClient } from "../src/mattermost.js";

test("Mattermost REST requests time out and reject redirects", async () => {
  let init;
  const client = createMattermostClient({
    baseUrl: "https://mm.example",
    token: "secret",
    fetchImpl: async (_url, options) => {
      init = options;
      return { ok: true, status: 200, async json() { return { order: [], posts: {} }; } };
    }
  });
  await client.latestPostId("c1");
  assert.equal(init.redirect, "error");
  assert.equal(init.signal.aborted, false);
  assert.equal(init.headers.Authorization, "Bearer secret");
});

test("revokeUserToken uses the Mattermost v4 token revoke endpoint and body", async () => {
  let request;
  const client = createMattermostClient({
    baseUrl: "https://mm.example",
    token: "secret",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, async json() { return {}; } };
    }
  });
  await client.revokeUserToken("token-123");
  assert.equal(request.url, "https://mm.example/api/v4/users/tokens/revoke");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { token_id: "token-123" });
});

test("team icon retrieval is authenticated, bounded, and profile upload uses multipart image field", async () => {
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10]);
  const calls = [];
  const client = createMattermostClient({
    baseUrl: "https://mm.example",
    token: "secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png", "content-length": String(imageBytes.length) }),
        body: new ReadableStream({ start(controller) { controller.enqueue(imageBytes); controller.close(); } })
      };
      return { ok: true, status: 200, async json() { return { status: "OK" }; } };
    }
  });
  const image = await client.getTeamIcon("team-1");
  await client.setUserProfileImage("bot-1", image);
  assert.equal(calls[0].url, "https://mm.example/api/v4/teams/team-1/image");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[1].url, "https://mm.example/api/v4/users/bot-1/image");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers["Content-Type"], undefined);
  const upload = calls[1].options.body.get("image");
  assert.equal(upload.name, "profile.png");
  assert.deepEqual(Buffer.from(await upload.arrayBuffer()), imageBytes);
});

test("team icon retrieval rejects bodies larger than one mebibyte", async () => {
  const oversized = new Uint8Array(1024 * 1024 + 1);
  const client = createMattermostClient({
    baseUrl: "https://mm.example",
    token: "secret",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({ start(controller) { controller.enqueue(oversized); controller.close(); } })
    })
  });
  await assert.rejects(client.getTeamIcon("team-1"), /1 MiB limit/);
});

test("postsAfter sorts chronologically and uses next_post_id when has_next is absent", async () => {
  const posts = {
    old: { id: "old", create_at: 10 },
    new: { id: "new", create_at: 20 }
  };
  const client = createMattermostClient({
    baseUrl: "https://mm.example",
    token: "secret",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { return { order: ["new", "old"], posts, next_post_id: "next" }; }
    })
  });
  assert.deepEqual(await client.postsAfter("c1", "anchor"), {
    posts: [posts.old, posts.new],
    hasNext: true
  });
});


test("bot profile updates use the Mattermost v4 PUT endpoint", async () => {
  let request;
  const client = createMattermostClient({
    baseUrl: "https://mm.example", token: "test-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, async json() { return { user_id: "bot-id" }; } };
    }
  });
  await client.patchBot("bot-id", { display_name: "Новое имя" });
  assert.equal(request.url, "https://mm.example/api/v4/bots/bot-id");
  assert.equal(request.options.method, "PUT");
  assert.deepEqual(JSON.parse(request.options.body), { display_name: "Новое имя" });
});

test("status reactions replace only the current bot status and preserve other reactions", async () => {
  const calls = [];
  const client = createMattermostClient({ baseUrl: "https://mm.example", token: "test-token", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, async json() {
      if (url.endsWith("/users/me")) return { id: "bot-1" };
      if (url.endsWith("/reactions") && !options.method) return [
        { user_id: "bot-1", emoji_name: "hourglass_flowing_sand" },
        { user_id: "other-bot", emoji_name: "hourglass_flowing_sand" },
        { user_id: "bot-1", emoji_name: "heart" }
      ];
      return {};
    } };
  } });
  await client.setPostStatus("post-1", "success");
  assert.deepEqual(JSON.parse(calls.find((call) => call.options.method === "POST").options.body), { user_id: "bot-1", post_id: "post-1", emoji_name: "white_check_mark" });
  const deletes = calls.filter((call) => call.options.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url, "https://mm.example/api/v4/users/bot-1/posts/post-1/reactions/hourglass_flowing_sand");
});
