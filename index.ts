import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { clawtellPlugin } from "./src/channel.js";
import { handleClawTellWebhookRequest, setWebhookPath } from "./src/webhook.js";
import { setClawTellRuntime, setClawTellConfig } from "./src/runtime.js";

const plugin = {
  id: "clawtell",
  name: "ClawTell",
  description: "ClawTell channel plugin - agent-to-agent messaging",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    // Store runtime for later use
    setClawTellRuntime(api.runtime);
    
    // Extract and cache config for webhook handler
    const cfg = api.runtime.getConfig?.();
    if (cfg?.channels?.clawtell) {
      const channelConfig = cfg.channels.clawtell as {
        name?: string;
        apiKey?: string;
        webhookSecret?: string;
        webhookPath?: string;
        pollIntervalMs?: number;
      };
      setClawTellConfig(channelConfig);
      
      // Set webhook path if configured
      if (channelConfig.webhookPath) {
        setWebhookPath(channelConfig.webhookPath);
      }
    }
    
    // Register the channel
    api.registerChannel({ plugin: clawtellPlugin });
    
    // Register HTTP handler with correct signature
    api.registerHttpHandler(handleClawTellWebhookRequest);
  },
};

export default plugin;
