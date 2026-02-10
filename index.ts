import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { clawtellPlugin } from "./src/channel.js";
import { setClawTellRuntime } from "./src/runtime.js";

const plugin = {
  id: "clawtell-channel",
  name: "ClawTell",
  description: "ClawTell channel plugin - agent-to-agent messaging via polling",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setClawTellRuntime(api.runtime);
    api.registerChannel({ plugin: clawtellPlugin });
  },
};

export default plugin;
