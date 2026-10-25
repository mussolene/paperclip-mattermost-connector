import test from "node:test";
import assert from "node:assert/strict";
import { createProfileProvisioner } from "../src/provisioning.js";

const agent1 = { id: "12345678-1234-1234-1234-123456789abc", name: "Аналитик", status: "idle" };
const companyId = "company-1";
const config = {
  companyId,
  mattermostBaseUrl: "https://mm.example",
  autoProvisionProfiles: true,
  teamId: "team-1",
  channelIds: ["channel-1"],
  profileAdminToken: { type: "secret_ref", secretId: "admin" },
  profileEncryptionKey: { type: "secret_ref", secretId: "key" }
};

function harness({ agents = [agent1], occupiedBot, teamIcon } = {}) {
  const state = new Map();
  const bots = new Map(occupiedBot ? [[occupiedBot.username, occupiedBot]] : []);
  const tokens = new Map();
  const memberships = new Set();
  const calls = { creates: 0, tokenCreates: 0, tokenRevokes: 0, iconReads: 0, imageUploads: 0 };
  const ctx = {
    agents: { async list() { return agents; } },
    state: {
      async get({ stateKey }) { return state.get(stateKey) ?? null; },
      async set({ stateKey }, value) { state.set(stateKey, value); }
    }
  };
  const api = {
    async getMe() { return { id: "admin-user" }; },
    async getTeamIcon() {
      calls.iconReads += 1;
      if (!teamIcon) { const error = new Error("not found"); error.status = 404; throw error; }
      return teamIcon;
    },
    async setUserProfileImage(userId, image) {
      calls.imageUploads += 1;
      calls.lastImageUpload = { userId, image };
    },
    async getUserByUsername(username) {
      const bot = bots.get(username);
      if (!bot) { const error = new Error("not found"); error.status = 404; throw error; }
      return { id: bot.user_id, is_bot: true };
    },
    async getBot(userId) {
      return [...bots.values()].find((bot) => bot.user_id === userId);
    },
    async createBot(input) {
      calls.creates += 1;
      const bot = { ...input, id: "bot-user-" + calls.creates, user_id: "bot-user-" + calls.creates, create_at: 100 };
      bots.set(bot.username, bot);
      return bot;
    },
    async patchBot(userId, input) {
      const bot = [...bots.values()].find((item) => item.user_id === userId);
      Object.assign(bot, input);
      return bot;
    },
    async getTeamMember(teamId, userId) { if (!memberships.has(teamId + ":" + userId)) { const error = new Error("not found"); error.status = 404; throw error; } },
    async addTeamMember(teamId, userId) { memberships.add(teamId + ":" + userId); },
    async getChannelMember(channelId, userId) { if (!memberships.has(channelId + ":" + userId)) { const error = new Error("not found"); error.status = 404; throw error; } },
    async addChannelMember(channelId, userId) { memberships.add(channelId + ":" + userId); },
    async listUserTokens(userId) { return tokens.get(userId) ?? []; },
    async revokeUserToken(tokenId) {
      calls.tokenRevokes += 1;
      for (const [userId, userTokens] of tokens) {
        tokens.set(userId, userTokens.filter((token) => token.id !== tokenId));
      }
    },
    async createUserToken(userId, description) {
      calls.tokenCreates += 1;
      const token = { id: "token-" + calls.tokenCreates, description, token: "plaintext-bot-secret-" + calls.tokenCreates };
      tokens.set(userId, [...(tokens.get(userId) ?? []), { id: token.id, description }]);
      return token;
    }
  };
  const provisioner = createProfileProvisioner({
    ctx,
    config,
    resolveSecret: async (reference) => reference.secretId === "key" ? "a".repeat(64) : "admin-secret",
    apiFactory: () => api
  });
  return { provisioner, state, bots, tokens, memberships, calls, setAgents(value) { agents = value; } };
}

test("managed bot token is encrypted in company state and reused", async () => {
  const h = harness();
  const first = await h.provisioner.sync();
  const record = h.state.get("mattermost-managed-profile:" + agent1.id);
  assert.equal(first[0].managedProfile, true);
  assert.equal(first[0].pollSince, 100);
  assert.equal(record.botUserId, "bot-user-1");
  assert.equal(JSON.stringify(record).includes("plaintext-bot-secret"), false);
  assert.equal(await h.provisioner.readToken(agent1.id), "plaintext-bot-secret-1");
  await h.provisioner.sync();
  assert.equal(h.calls.creates, 1);
  assert.equal(h.calls.tokenCreates, 1);
});

test("foreign deterministic username collision fails closed without creating a token", async () => {
  const username = "pc-12345678123412341234";
  const h = harness({ occupiedBot: {
    id: "foreign-id", user_id: "foreign-id", username,
    owner_id: "someone-else",
    description: "Paperclip managed agent id=" + agent1.id + "; unrelated"
  } });
  await assert.rejects(h.provisioner.sync(), /does not identify a bot owned/);
  assert.equal(h.calls.creates, 0);
  assert.equal(h.calls.tokenCreates, 0);
});

test("orphaned plugin-owned tokens are revoked before replacement after a state-write crash", async () => {
  const h = harness();
  await h.provisioner.sync();
  h.state.delete("mattermost-managed-profile:" + agent1.id);
  h.tokens.set("bot-user-1", [{ id: "orphan", description: "catacode-paperclip-managed:" + agent1.id }]);
  await h.provisioner.sync();
  assert.equal(h.calls.tokenRevokes, 1);
  assert.equal(h.calls.tokenCreates, 2);
});

test("a newly created Paperclip agent is discovered on the next sync without restart", async () => {
  const h = harness();
  await h.provisioner.sync();
  const agent2 = { id: "22345678-1234-1234-1234-123456789abc", name: "Разработчик", status: "idle" };
  h.setAgents([agent1, agent2]);
  const profiles = await h.provisioner.sync();
  assert.deepEqual(profiles.map((profile) => profile.agentId), [agent1.id, agent2.id]);
  assert.equal(h.calls.creates, 2);
});

test("managed Mattermost bot display name includes the Paperclip role and description identifies Катакод", async () => {
  const agent = { ...agent1, name: "Аналитик", title: "Финансовый эксперт" };
  const h = harness({ agents: [agent] });
  await h.provisioner.sync();
  const bot = [...h.bots.values()][0];
  assert.equal(bot.display_name, "Аналитик · Финансовый эксперт");
  assert.match(bot.description, new RegExp("Paperclip managed agent id=" + agent.id + "; Paperclip agent"));
  assert.ok(bot.display_name.length <= 64);
});

test("automatic profiles copy the team icon once and reuse its saved hash", async () => {
  const teamIcon = { data: Buffer.from("team-icon"), contentType: "image/png" };
  const h = harness({ teamIcon });
  await h.provisioner.sync();
  const record = h.state.get("mattermost-managed-profile:" + agent1.id);
  assert.equal(h.calls.iconReads, 1);
  assert.equal(h.calls.imageUploads, 1);
  assert.equal(record.avatarHash?.length, 64);
  await h.provisioner.sync();
  assert.equal(h.calls.imageUploads, 1);
});

test("automatic profile creation proceeds when the team has no icon", async () => {
  const h = harness();
  const profiles = await h.provisioner.sync();
  assert.equal(profiles.length, 1);
  assert.equal(h.calls.creates, 1);
  assert.equal(h.calls.imageUploads, 0);
  assert.equal(h.state.get("mattermost-managed-profile:" + agent1.id).avatarHash, undefined);
});

test("manually configured agent mapping is reused without provisioning a duplicate", async () => {
  const h = harness();
  const profiles = await h.provisioner.sync([{ agentId: agent1.id }]);
  assert.deepEqual(profiles, []);
  assert.equal(h.calls.creates, 0);
});
