export function normalizeBaseUrl(value, allowInsecureLocal = false) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Mattermost URL должен быть непустой строкой");
  }
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Mattermost URL не должен содержать учетные данные");
  if (url.search || url.hash) throw new Error("Mattermost URL не должен содержать query или fragment");
  const localHost = ["localhost", "127.0.0.1", "::1", "[::1]", "mattermost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowInsecureLocal && localHost)) {
    throw new Error("Mattermost требует HTTPS; HTTP разрешен только для локального стенда при включенном allowInsecureLocal");
  }
  return url.toString().replace(/\/$/, "");
}

function requireNonemptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} должен быть непустой строкой`);
  }
}

function requireStringList(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} должен быть непустым массивом строк`);
  const seen = new Set();
  for (const item of value) {
    requireNonemptyString(item, `${name} элемент`);
    if (seen.has(item)) throw new Error(`${name} не должен содержать дубликаты`);
    seen.add(item);
  }
}

function requireSecretRef(value, name) {
  if (value?.type !== "secret_ref") throw new Error(`${name} должен быть ссылкой secret_ref`);
  requireNonemptyString(value.secretId, `${name}.secretId`);
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Конфигурация должна быть объектом");
  requireNonemptyString(config.companyId, "companyId");
  const mattermostBaseUrl = normalizeBaseUrl(config.mattermostBaseUrl, config.allowInsecureLocal === true);
  requireStringList(config.channelIds, "channelIds");
  requireStringList(config.allowedUserIds, "allowedUserIds");

  for (const flag of ["autoProvisionProfiles", "allowInsecureLocal"]) {
    if (config[flag] !== undefined && typeof config[flag] !== "boolean") throw new Error(`${flag} должен быть boolean`);
  }
  if (!Array.isArray(config.bots)) throw new Error("bots должен быть массивом");
  if (config.autoProvisionProfiles === true) {
    requireNonemptyString(config.teamId, "teamId");
    requireSecretRef(config.profileAdminToken, "profileAdminToken");
    requireSecretRef(config.profileEncryptionKey, "profileEncryptionKey");
  } else {
    if (!Array.isArray(config.bots) || config.bots.length === 0) throw new Error("bots должен быть непустым массивом");
  }
  if (config.bots !== undefined) {
    if (!Array.isArray(config.bots)) throw new Error("bots должен быть массивом");
    const identities = { agentId: new Set(), botUserId: new Set(), botUsername: new Set() };
    for (const bot of config.bots) {
      if (!bot || typeof bot !== "object" || Array.isArray(bot)) throw new Error("Каждый bot должен быть объектом");
      for (const key of Object.keys(identities)) {
        requireNonemptyString(bot[key], `bot.${key}`);
        const identity = key === "botUsername" ? bot[key].toLocaleLowerCase("en-US") : bot[key];
        if (identities[key].has(identity)) throw new Error(`bots содержит повторяющийся ${key}`);
        identities[key].add(identity);
      }
      requireSecretRef(bot.token, "bot.token");
    }
  }

  if (config.financeAgentId !== undefined) requireNonemptyString(config.financeAgentId, "financeAgentId");
  return { ...config, mattermostBaseUrl };
}
