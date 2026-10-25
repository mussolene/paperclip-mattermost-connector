const manifest = {
  id: "catacode.paperclip-mattermost",
  apiVersion: 1,
  version: "0.3.0-beta.1",
  displayName: "Mattermost для Paperclip",
  description: "Отвечает на вопросы в Mattermost и создает назначенные задачи Paperclip по поручениям.",
  author: "Catacode",
  categories: ["connector", "automation"],
  capabilities: [
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "issue.comments.read",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref"
  ],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  instanceConfigSchema: {
    type: "object",
    required: ["companyId", "mattermostBaseUrl", "channelIds", "allowedUserIds", "bots"],
    allOf: [{
      if: { required: ["autoProvisionProfiles"], properties: { autoProvisionProfiles: { const: true } } },
      then: { required: ["teamId", "profileAdminToken", "profileEncryptionKey"] },
      else: { properties: { bots: { minItems: 1 } } }
    }],
    properties: {
      companyId: { type: "string", title: "ID компании Paperclip" },
      financeAgentId: { type: "string", title: "ID агента предварительной оценки поручений" },
      mattermostBaseUrl: { type: "string", title: "Адрес Mattermost", format: "uri" },
      allowInsecureLocal: { type: "boolean", title: "Разрешить HTTP для локальной сети Docker", default: false },
      autoProvisionProfiles: { type: "boolean", title: "Автоматически создавать профили ботов", default: false },
      teamId: { type: "string", title: "ID команды Mattermost" },
      profileAdminToken: {
        type: "object",
        title: "Ссылка на секрет администратора Mattermost",
        required: ["type", "secretId"],
        properties: {
          type: { type: "string", const: "secret_ref" },
          secretId: { type: "string" },
          version: { type: "string" }
        }
      },
      profileEncryptionKey: {
        type: "object",
        title: "Ссылка на секрет ключа шифрования профилей",
        required: ["type", "secretId"],
        properties: {
          type: { type: "string", const: "secret_ref" },
          secretId: { type: "string" },
          version: { type: "string" }
        }
      },
      channelIds: { type: "array", title: "Разрешенные каналы", items: { type: "string" }, minItems: 1 },
      allowedUserIds: { type: "array", title: "Разрешенные пользователи Mattermost", items: { type: "string" }, minItems: 1 },
      bots: {
        type: "array",
        title: "Боты агентов",
        items: {
          type: "object",
          required: ["agentId", "botUserId", "botUsername", "token"],
          properties: {
            agentId: { type: "string", title: "ID агента Paperclip" },
            displayName: { type: "string", title: "Имя профиля бота" },
            role: { type: "string", title: "Роль агента" },
            botUserId: { type: "string", title: "ID пользователя Mattermost" },
            botUsername: { type: "string", title: "Имя бота Mattermost" },
            token: {
              type: "object",
              title: "Ссылка на секрет токена",
              required: ["type", "secretId"],
              properties: {
                type: { type: "string", const: "secret_ref" },
                secretId: { type: "string" },
                version: { type: "string" }
              }
            }
          }
        }
      }
    }
  },
  jobs: [
    {
      jobKey: "poll-and-reconcile",
      displayName: "Проверка Mattermost и результатов задач",
      description: "Проверяет разрешенные каналы и отправляет готовые ответы в исходные ветки.",
      schedule: "* * * * *"
    }
  ]
};

export default manifest;
