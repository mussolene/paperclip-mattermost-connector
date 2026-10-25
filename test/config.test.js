import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl, validateConfig } from "../src/config.js";

const secret = (secretId = "secret-1") => ({ type: "secret_ref", secretId });
const bot = (overrides = {}) => ({ agentId: "agent-1", botUserId: "user-1", botUsername: "Analyst", token: secret(), ...overrides });
const config = (overrides = {}) => ({
  companyId: "company-1",
  mattermostBaseUrl: "https://mattermost.example",
  channelIds: ["channel-1"],
  allowedUserIds: ["user-1"],
  bots: [bot()],
  ...overrides
});

test("validates required configuration and preserves reverse proxy subpaths", () => {
  const valid = validateConfig(config({ mattermostBaseUrl: "https://mm.example/mattermost/" }));
  assert.equal(valid.mattermostBaseUrl, "https://mm.example/mattermost");
  assert.throws(() => validateConfig(config({ companyId: " " })), /companyId/);
  assert.throws(() => validateConfig(config({ mattermostBaseUrl: "" })), /URL/);
  assert.throws(() => validateConfig(config({ channelIds: [] })), /channelIds/);
  assert.throws(() => validateConfig(config({ allowedUserIds: [] })), /allowedUserIds/);
});

test("accepts valid profile provisioning with an empty bots list and validates its required refs", () => {
  const provisioning = {
    autoProvisionProfiles: true,
    teamId: "team-1",
    profileAdminToken: secret("admin"),
    profileEncryptionKey: secret("encryption")
  };
  assert.equal(validateConfig(config({ ...provisioning, bots: [] })).autoProvisionProfiles, true);
  assert.throws(() => validateConfig(config({ autoProvisionProfiles: true, teamId: "team-1" })), /profileAdminToken/);
  assert.throws(() => validateConfig(config({ ...provisioning, teamId: " " })), /teamId/);
  assert.throws(() => validateConfig(config({ ...provisioning, profileEncryptionKey: { type: "secret_ref", secretId: " " } })), /secretId/);
});

test("requires bots when provisioning is disabled and accepts a false flag", () => {
  assert.equal(validateConfig(config({ autoProvisionProfiles: false })).bots.length, 1);
  assert.throws(() => validateConfig(config({ autoProvisionProfiles: false, bots: [] })), /bots/);
});

test("validates bot identities and rejects duplicates case-insensitively for usernames", () => {
  assert.throws(() => validateConfig(config({ bots: [bot(), bot({ botUserId: "user-2", botUsername: "other" })] })), /agentId/);
  assert.throws(() => validateConfig(config({ bots: [bot(), bot({ agentId: "agent-2", botUserId: "user-2" })] })), /botUsername/);
  assert.throws(() => validateConfig(config({ bots: [bot(), bot({ agentId: "agent-2", botUserId: "user-2", botUsername: "analyst" })] })), /botUsername/);
  assert.throws(() => validateConfig(config({ bots: [bot({ token: { type: "secret_ref", secretId: " " } })] })), /secretId/);
  assert.throws(() => validateConfig(config({ financeAgentId: " " })), /financeAgentId/);
});

test("normalizes accepted URLs and rejects credentials, query, fragments, and remote HTTP", () => {
  assert.equal(normalizeBaseUrl("http://mattermost:8065/proxy", true), "http://mattermost:8065/proxy");
  assert.throws(() => normalizeBaseUrl("https://user:pass@mm.example"), /учетные данные/);
  assert.throws(() => normalizeBaseUrl("https://mm.example/path?x=1"), /query/);
  assert.throws(() => normalizeBaseUrl("https://mm.example/path#x"), /fragment/);
  assert.throws(() => normalizeBaseUrl("http://mm.example", true));
});

test("rejects malformed lists and secret references without coercion", () => {
  assert.throws(() => validateConfig(config({ channelIds: ["a", "a"] })), /дубликаты/);
  assert.throws(() => validateConfig(config({ allowedUserIds: ["a", 1] })), /строкой/);
  assert.throws(() => validateConfig(config({ bots: [bot({ agentId: 1 })] })), /строкой/);
  assert.throws(() => validateConfig(config({ bots: [bot({ token: { type: "plain", secretId: "x" } })] })), /token/);
});
