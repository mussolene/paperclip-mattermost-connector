import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { activeAgents } from "./core.js";

const STATE_PREFIX = "mattermost-managed-profile:";
const TOKEN_DESCRIPTION_PREFIX = "catacode-paperclip-managed:";

function managedDisplayName(agent) {
  const label = [agent.name, agent.title].filter(Boolean).join(" · ");
  return String(label || agent.name).slice(0, 64);
}

function managedDescription(agent) {
  return "Paperclip managed agent id=" + agent.id + "; Paperclip agent " + agent.name + (agent.title ? "; роль: " + agent.title : "");
}

function profileUsername(agentId) {
  const compactId = agentId.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{20,}$/u.test(compactId)) throw new Error("Automatic Mattermost profiles require UUID agent IDs");
  return "pc-" + compactId.slice(0, 20);
}

function decodeKey(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value)) throw new Error("The Paperclip profile encryption secret must be 32-byte hexadecimal");
  return Buffer.from(value, "hex");
}

function encryptToken(token, key, associatedData) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("hex"), ciphertext: ciphertext.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

function decryptToken(record, key, associatedData) {
  if (record?.version !== 1 || !record.iv || !record.ciphertext || !record.tag) throw new Error("Stored Mattermost profile token is incomplete");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "hex"));
  decipher.setAAD(Buffer.from(associatedData));
  decipher.setAuthTag(Buffer.from(record.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "hex")), decipher.final()]).toString("utf8");
}

function isNotFound(error) {
  return error?.status === 404;
}

export function createProfileProvisioner({ ctx, config, resolveSecret, apiFactory }) {
  let syncInFlight;
  function stateKey(agentId) { return STATE_PREFIX + agentId; }
  async function keyForCompany() {
    return decodeKey(await resolveSecret(config.profileEncryptionKey, config.companyId));
  }
  async function readRecord(agentId) {
    return ctx.state.get({ scopeKind: "company", scopeId: config.companyId, stateKey: stateKey(agentId) });
  }
  async function api() {
    const token = await resolveSecret(config.profileAdminToken, config.companyId);
    return apiFactory({ baseUrl: config.mattermostBaseUrl, token });
  }
  async function readToken(agentId) {
    const record = await readRecord(agentId);
    if (!record?.encryptedToken) throw new Error("Encrypted Mattermost profile token is unavailable");
    const key = await keyForCompany();
    try {
      return decryptToken(record.encryptedToken, key, config.companyId + ":" + agentId + ":" + record.botUserId);
    } finally {
      key.fill(0);
    }
  }

  async function getActiveAgents() {
    const agents = [];
    for (let offset = 0; ; offset += 200) {
      const page = await ctx.agents.list({ companyId: config.companyId, limit: 200, offset });
      agents.push(...page);
      if (page.length < 200) break;
    }
    return activeAgents(agents);
  }

  async function lookupOwnedBot(client, username, agentId, ownerId) {
    let user;
    try {
      user = await client.getUserByUsername(username);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if (!user.is_bot) throw new Error("Mattermost deterministic username is occupied by a non-bot account");
    const bot = await client.getBot(user.id);
    if (bot.owner_id !== ownerId || bot.username !== username || !String(bot.description ?? "").includes("Paperclip managed agent id=" + agentId + ";")) {
      throw new Error("Mattermost username exists but does not identify a bot owned by this integration");
    }
    return bot;
  }

  async function ensureMembership(client, botUserId) {
    let teamExists = true;
    try { await client.getTeamMember(config.teamId, botUserId); } catch (error) { if (isNotFound(error)) teamExists = false; else throw error; }
    if (!teamExists) await client.addTeamMember(config.teamId, botUserId);
    for (const channelId of config.channelIds) {
      let channelExists = true;
      try { await client.getChannelMember(channelId, botUserId); } catch (error) { if (isNotFound(error)) channelExists = false; else throw error; }
      if (!channelExists) await client.addChannelMember(channelId, botUserId);
    }
  }

  async function createOrRecoverToken(client, botUserId, agentId, key) {
    const description = TOKEN_DESCRIPTION_PREFIX + agentId;
    const tokens = await client.listUserTokens(botUserId);
    for (const token of tokens) {
      if (token.description === description) await client.revokeUserToken(token.id);
    }
    const created = await client.createUserToken(botUserId, description);
    if (!created?.id || !created?.token) throw new Error("Mattermost did not return a usable bot token");
    return { encryptedToken: encryptToken(created.token, key, config.companyId + ":" + agentId + ":" + botUserId), tokenId: created.id };
  }

  async function provisionAgent(client, ownerId, agent, teamIcon, key) {
    const agentId = agent.id;
    const username = profileUsername(agentId);
    const displayName = managedDisplayName(agent);
    const description = managedDescription(agent);
    const storedRecord = await readRecord(agentId);
    let bot = null;
    if (storedRecord?.botUserId) {
      try {
        bot = await client.getBot(storedRecord.botUserId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        throw new Error("Stored Mattermost profile no longer exists; refusing to create a replacement automatically");
      }
      if (bot.owner_id !== ownerId || bot.username !== username || !String(bot.description ?? "").includes("Paperclip managed agent id=" + agentId + ";")) {
        throw new Error("Stored Mattermost profile identity failed ownership verification");
      }
    } else {
      bot = await lookupOwnedBot(client, username, agentId, ownerId);
    }
    if (!bot) {
      try {
        const created = await client.createBot({ username, display_name: displayName, description, owner_id: ownerId });
        bot = await client.getBot(created.user_id ?? created.id);
      } catch (error) {
        bot = await lookupOwnedBot(client, username, agentId, ownerId);
        if (!bot) throw error;
      }
      if (bot.owner_id !== ownerId || bot.username !== username || !String(bot.description ?? "").includes("Paperclip managed agent id=" + agentId + ";")) {
        throw new Error("Mattermost created a bot whose returned identity failed ownership verification");
      }
    }
    if (bot.display_name !== displayName || bot.description !== description) {
      bot = await client.patchBot(bot.user_id ?? bot.id, { display_name: displayName, description });
      if (bot.owner_id !== ownerId || bot.username !== username || !String(bot.description ?? "").includes("Paperclip managed agent id=" + agentId + ";")) {
        throw new Error("Mattermost profile update failed ownership verification");
      }
    }

    const botUserId = bot.user_id ?? bot.id;
    let record = storedRecord;
    if (record && record.botUserId !== botUserId) throw new Error("Stored Mattermost profile identity does not match the owned bot");
    if (!record?.encryptedToken) {
      const token = await createOrRecoverToken(client, botUserId, agentId, key);
      record = { botUserId, botUsername: username, ownerId, encryptedToken: token.encryptedToken, tokenId: token.tokenId };
      await ctx.state.set({ scopeKind: "company", scopeId: config.companyId, stateKey: stateKey(agentId) }, record);
    }
    await ensureMembership(client, botUserId);
    if (teamIcon) {
      const avatarHash = createHash("sha256").update(teamIcon.data).digest("hex");
      if (record.avatarHash !== avatarHash) {
        await client.setUserProfileImage(botUserId, teamIcon);
        record = { ...record, avatarHash };
        await ctx.state.set({ scopeKind: "company", scopeId: config.companyId, stateKey: stateKey(agentId) }, record);
      }
    }
    return {
      agentId, botUserId, botUsername: username, displayName,
      role: agent.title ?? "", managedProfile: true, tokenGeneration: record.tokenId,
      pollSince: bot.create_at || Date.now()
    };
  }

  return {
    async sync(staticBots = []) {
      if (syncInFlight) return syncInFlight;
      syncInFlight = syncProfiles(staticBots);
      try {
        return await syncInFlight;
      } finally {
        syncInFlight = null;
      }
    },
    readToken,
    inspectRecord: readRecord
  };

  async function syncProfiles(staticBots = []) {
      if (!config.autoProvisionProfiles) return [];
      if (!config.teamId || !config.profileAdminToken || !config.profileEncryptionKey) throw new Error("Automatic profiles require teamId, profileAdminToken, and profileEncryptionKey");
      const client = await api();
      const owner = await client.getMe();
      if (!owner?.id) throw new Error("Mattermost profile administrator identity could not be verified");
      const agents = await getActiveAgents();
      const staticAgentIds = new Set(staticBots.map((bot) => bot.agentId));
      const agentsToProvision = agents.filter((agent) => !staticAgentIds.has(agent.id));
      let teamIcon = null;
      if (agentsToProvision.length) {
        try {
          teamIcon = await client.getTeamIcon(config.teamId);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      if (!agentsToProvision.length) return [];
      const key = await keyForCompany();
      try {
        const managed = [];
        for (const agent of agentsToProvision) managed.push(await provisionAgent(client, owner.id, agent, teamIcon, key));
        return managed;
      } finally {
        key.fill(0);
      }
  }
}
