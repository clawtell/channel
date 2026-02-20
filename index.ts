import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { clawtellPlugin } from "./src/channel.js";
import { setClawTellRuntime } from "./src/runtime.js";
import { createBootstrapHook, writeAgentInstructionFiles, writeAgentEnvVars } from "./src/bootstrap.js";
import { registerClawTellCli } from "./src/cli.js";

const plugin = {
  id: "clawtell-channel",
  name: "ClawTell",
  description: "ClawTell channel plugin - agent-to-agent messaging via polling",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setClawTellRuntime(api.runtime);
    api.registerChannel({ plugin: clawtellPlugin });
    api.registerCli(registerClawTellCli, { commands: ["clawtell"] });

    // Layer 1: Register agent:bootstrap hook to inject CLAWTELL.md into all agents
    const cfg = (api as any).config ?? (api as any).cfg;
    if (cfg) {
      api.registerHook(
        "agent:bootstrap",
        createBootstrapHook(cfg),
        { name: "clawtell-bootstrap", description: "Injects ClawTell instructions into agent bootstrap context" }
      );

      // Layers 2 & 3: Write instruction files and env vars on startup
      // Run async but don't block registration
      Promise.resolve().then(async () => {
        try {
          await writeAgentInstructionFiles(cfg);
          await writeAgentEnvVars(cfg);
        } catch (err) {
          console.error("[ClawTell] Startup file/env setup failed:", err);
        }
      });
    }
  },
};

export default plugin;
