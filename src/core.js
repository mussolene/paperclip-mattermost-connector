export const PLUGIN_KEY = "catacode.paperclip-mattermost";
export const ORIGIN_KIND = `plugin:${PLUGIN_KEY}:post`;
export const MAX_INPUT_LENGTH = 4000;

const TASK_VERBS = /^(?:исследуй|исследовать|поисследуй|изучи|изучить|посмотри|посмотреть|сделай|сделать|исправь|исправить|проверь|проверить|создай|создать|настрой|настроить|подготовь|подготовить|выполни|выполнить|запусти|запустить|измени|изменить|обнови|обновить|удали|удалить|добавь|добавить|реализуй|реализовать|разработай|разработать|почини|починить|перенеси|перенести|собери|собрать|напиши|написать|найди|найти|сравни|сравнить|проанализируй|проанализировать|подключи|подключить|установи|установить|опубликуй|опубликовать)(?=\s|$)/iu;
const QUESTION_START = /^(?:что|кто|где|когда|почему|зачем|как|какой|какая|какие|сколько|можно\s+ли|подскажи|расскажи|объясни|привет|здравствуй|доброе\s+(?:утро|день|вечер)|спасибо|понятно|согласен|согласна)\b/iu;

export function normalizeSlug(value) {
  return String(value ?? "")
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

export function parseMentionedCommand(message, username) {
  const mention = new RegExp(`(?:^|\\s)@${escapeRegExp(username)}(?:\\s|$)`, "i");
  const match = mention.exec(String(message ?? ""));
  if (!match) return null;
  const command = String(message).slice(match.index + match[0].length).trim();
  if (/^(?:агенты|agents|помощь|help)$/i.test(command)) return { kind: "agents" };
  const selector = /^(?:агент|agent):([\p{L}\p{N}._-]+)\s+([\s\S]+)$/iu.exec(command);
  if (selector) return classifyCommand(selector[2].trim(), normalizeSlug(selector[1]));
  if (/^(?:агент|agent):/iu.test(command)) return { kind: "usage" };
  if (!command) return { kind: "usage" };
  if (/^(?:задача|task):\s*$/iu.test(command) || /^(?:вопрос|question):\s*$/iu.test(command)) return { kind: "usage" };
  return classifyCommand(command, null);
}

function classifyCommand(command, slug) {
  if (/^(?:задача|task):\s*$/iu.test(command) || /^(?:вопрос|question):\s*$/iu.test(command)) return { kind: "usage" };
  const explicitTask = /^(?:задача|task):\s*([\s\S]+)$/iu.exec(command);
  if (explicitTask) return explicitTask[1].trim() ? { kind: "task", slug, text: explicitTask[1].trim() } : { kind: "usage" };
  const explicitQuestion = /^(?:вопрос|question):\s*([\s\S]+)$/iu.exec(command);
  if (explicitQuestion) return explicitQuestion[1].trim() ? { kind: "question", slug, text: explicitQuestion[1].trim() } : { kind: "usage" };
  if (TASK_VERBS.test(command)) return { kind: "task", slug, text: command };
  if (command.endsWith("?") || QUESTION_START.test(command)) return { kind: "question", slug, text: command };
  // Ambiguous and conversational messages stay in read-only consultation mode.
  return { kind: "question", slug, text: command };
}

export function parseMattermostSocketEvent(raw) {
  let event;
  try { event = JSON.parse(typeof raw === "string" ? raw : String(raw)); } catch { return null; }
  if (!new Set(["posted", "post_edited"]).has(event?.event) || !event.data?.post) return null;
  try {
    const post = typeof event.data.post === "string" ? JSON.parse(event.data.post) : event.data.post;
    return post?.id && post?.channel_id && post?.user_id && typeof post.message === "string"
      ? (event.event === "post_edited" ? { ...post, paperclipEvent: event.event } : post)
      : null;
  } catch { return null; }
}

export function isAllowedPost(post, { channelIds, allowedUserIds, botUserIds }) {
  return Boolean(post?.id)
    && channelIds.includes(post.channel_id)
    && allowedUserIds.includes(post.user_id)
    && !botUserIds.has(post.user_id)
    && !post.type;
}

export function originIdForPost(post) {
  return `${post.channel_id}:${post.id}`;
}

export function activeAgents(agents) {
  const blockedLifecycles = new Set(["paused", "terminated", "archived", "verifying"]);
  return agents.filter((agent) => {
    if (blockedLifecycles.has(agent.lifecycleState)) return false;
    if (["idle", "running", "active"].includes(agent.status)) return true;
    return agent.status === "error" && (agent.lifecycleState == null || agent.lifecycleState === "ready");
  });
}

export function findAgentBySlug(agents, slug) {
  const found = activeAgents(agents).filter((agent) => normalizeSlug(agent.name) === slug);
  return found.length === 1 ? found[0] : null;
}

export function selectFinalComment(comments, agentId) {
  return [...comments]
    .reverse()
    .find((comment) => comment.authorAgentId === agentId && typeof comment.body === "string" && comment.body.trim());
}

export function hasDelivery(thread, deliveryKey) {
  return Object.values(thread?.posts ?? {}).some((post) => post.props?.paperclip_delivery_key === deliveryKey);
}

export async function postOnce(client, request) {
  const thread = await client.getThread(request.rootId);
  if (hasDelivery(thread, request.deliveryKey)) return false;
  await client.createReply(request);
  return true;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
