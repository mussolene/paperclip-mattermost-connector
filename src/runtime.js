import { AsyncResource } from "node:async_hooks";
import { createConnectorService } from "./service.js";
import { startMattermostSockets } from "./socket.js";
import { validateConfig } from "./config.js";
import { createProfileProvisioner } from "./provisioning.js";
import { createMattermostClient } from "./mattermost.js";

const JOB_KEY = "poll-and-reconcile";
const proactiveResource = new AsyncResource("paperclip-mattermost-proactive");

function inProactiveScope(callback) {
  return proactiveResource.runInAsyncScope(callback);
}

export function createPluginRuntime({ serviceFactory = createConnectorService, socketFactory = startMattermostSockets } = {}) {
  let ctx;
  let service;
  let sockets;
  let eventUnsubscribers = [];
  let profileProvisioner;
  let runtimeConfig;
  let staticBots = [];
  let profileSyncFailures = 0;
  let pluginLogger;

  async function runPoll(job = {}) {
    if (!runtimeConfig && job.companyId) {
      const config = await ctx.config.get(job.companyId);
      await applyConfig(config, { companyId: job.companyId });
    }
    if (!service) throw new Error("Mattermost connector is awaiting company configuration");
    if (job.companyId && job.companyId !== runtimeConfig.companyId) throw new Error("Mattermost connector received a job for an unexpected company");
    if (profileProvisioner) {
      const previousBots = runtimeConfig.bots;
      try {
        const nextBots = [...staticBots, ...await profileProvisioner.sync(staticBots)];
        runtimeConfig.bots = nextBots;
        await service.initializeCursors();
        inProactiveScope(() => sockets.updateBots(nextBots));
      } catch (error) {
        runtimeConfig.bots = previousBots;
        profileSyncFailures += 1;
        sockets?.reportFailure("profile_sync_failed");
        pluginLogger?.warn("Automatic Mattermost profile synchronization failed", { failureCount: profileSyncFailures, httpStatus: Number.isInteger(error?.status) ? error.status : undefined });
      }
    }
    await service.pollAndReconcile();
  }

  async function applyConfig(config, { companyId } = {}) {
    if (!companyId) throw new Error("Mattermost company-scoped configuration is required");
    if (runtimeConfig && runtimeConfig.companyId !== companyId) throw new Error("Mattermost connector supports one company per worker");
    if (config?.companyId && config.companyId !== companyId) throw new Error("Mattermost configuration company does not match invocation");
    const validated = validateConfig({ ...config, companyId });
    for (const unsubscribe of eventUnsubscribers) unsubscribe();
    eventUnsubscribers = [];
    if (sockets) sockets.close();
    if (service) await service.drain();
    runtimeConfig = validated;
    staticBots = config.bots.map((bot) => ({ ...bot, pollSince: bot.pollSince ?? Date.now() }));
    runtimeConfig.bots = staticBots;
    profileProvisioner = null;
    if (config.autoProvisionProfiles) {
      profileProvisioner = createProfileProvisioner({
        ctx,
        config: runtimeConfig,
        resolveSecret: (reference, scopedCompanyId) => ctx.secrets.resolve(reference, { companyId: scopedCompanyId }),
        apiFactory: createMattermostClient
      });
      try {
        runtimeConfig.bots = [...staticBots, ...await profileProvisioner.sync(staticBots)];
      } catch (error) {
        profileSyncFailures += 1;
        ctx.logger.warn("Automatic Mattermost profile synchronization failed", { failureCount: profileSyncFailures, httpStatus: Number.isInteger(error?.status) ? error.status : undefined });
      }
    }
    const resolveToken = (bot, scopedCompanyId) => bot.managedProfile
      ? profileProvisioner.readToken(bot.agentId)
      : ctx.secrets.resolve(bot.token, { companyId: scopedCompanyId });
    service = serviceFactory({ ctx, config: runtimeConfig, resolveToken });
    await service.initializeCursors();
    await service.recoverQuestions?.();
    const currentService = service;
    const reconcileEvent = async (event) => {
      if (event.companyId !== runtimeConfig.companyId) return;
      if (event.entityId) await currentService.reconcileIssues(event.entityId);
    };
    eventUnsubscribers = [
      ctx.events.on("issue.updated", { companyId }, reconcileEvent),
      ctx.events.on("issue.comment.created", { companyId }, reconcileEvent)
    ];
    sockets = inProactiveScope(() => socketFactory({
      config: runtimeConfig,
      resolveToken: (bot, scopedCompanyId) => inProactiveScope(() => resolveToken(bot, scopedCompanyId)),
      dispatchPost: (bot, post) => inProactiveScope(() => currentService.dispatchPost(bot, post)),
      logger: ctx.logger
    }));
  }

  return {
    async setup(pluginContext) {
      ctx = pluginContext;
      pluginLogger = ctx.logger;
      ctx.jobs.register(JOB_KEY, runPoll);
    },
    onConfigChanged: applyConfig,
    async onShutdown() {
      for (const unsubscribe of eventUnsubscribers) unsubscribe();
      eventUnsubscribers = [];
      sockets?.close();
      if (service) await service.drain();
    },
    async onHealth() {
      const diagnostics = sockets?.diagnostics() ?? { authenticatedSockets: 0, failureCount: 0 };
      diagnostics.profileSyncFailures = profileSyncFailures;
      const configured = Boolean(service);
      return {
        status: !configured || diagnostics.failureCount || profileSyncFailures ? "degraded" : "ok",
        message: configured ? "Mattermost WebSocket connector and recovery polling are ready" : "Awaiting company-scoped Mattermost configuration",
        details: diagnostics
      };
    }
  };
}
