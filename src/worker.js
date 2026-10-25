import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createPluginRuntime } from "./runtime.js";

const plugin = definePlugin({
  ...createPluginRuntime()
});

export default plugin;
runWorker(plugin, import.meta.url);
