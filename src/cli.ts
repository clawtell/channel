/**
 * ClawTell CLI commands — registered via api.registerCli()
 *
 * Commands:
 *   openclaw clawtell add-route    — add a routing entry
 *   openclaw clawtell list-routes   — show current routing table
 *   openclaw clawtell remove-route  — remove a routing entry
 */

import * as fs from "fs";
import * as path from "path";

/* ── helpers ────────────────────────────────────────── */

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function resolveConfigPath(): string {
  const env = process.env.CLAWDBOT_CONFIG ?? process.env.OPENCLAW_CONFIG;
  if (env) return path.resolve(env);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/root";
  for (const candidate of [
    path.join(home, ".clawdbot", "openclaw.json"),
    path.join(home, ".clawdbot", "clawdbot.json"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(home, ".clawdbot", "openclaw.json");
}

function readConfig(cfgPath: string): any {
  return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
}

function writeConfig(cfgPath: string, cfg: any): void {
  const bak = cfgPath + ".bak";
  if (fs.existsSync(cfgPath)) {
    fs.copyFileSync(cfgPath, bak);
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
}

function getAgentIds(cfg: any): string[] {
  return (cfg?.agents?.list ?? []).map((a: any) => a.id).filter(Boolean);
}

function getRouting(cfg: any): Record<string, any> {
  return cfg?.channels?.clawtell?.routing ?? {};
}

function setRouting(cfg: any, routing: Record<string, any>): void {
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.clawtell) cfg.channels.clawtell = {};
  cfg.channels.clawtell.routing = routing;
}

/* ── command registration ───────────────────────────── */

export function registerClawTellCli({ program }: { program: any; config: any; workspaceDir: string; logger: any }) {
  const clawtell = program
    .command("clawtell")
    .description("ClawTell route management");

  /* ── add-route ── */
  clawtell
    .command("add-route")
    .description("Add a ClawTell routing entry")
    .requiredOption("--name <name>", "ClawTell name (lowercase, alphanumeric, hyphens)")
    .requiredOption("--agent <agentId>", "Target agent ID")
    .option("--api-key <key>", "Per-route API key")
    .option("--forward <bool>", "Forward to human chat", "true")
    .action((opts: any) => {
      const name: string = opts.name.toLowerCase();
      if (!NAME_RE.test(name)) {
        console.error(`❌ Invalid name "${name}". Must be lowercase alphanumeric + hyphens, starting with a letter/digit.`);
        process.exit(1);
      }

      const cfgPath = resolveConfigPath();
      const cfg = readConfig(cfgPath);
      const agents = getAgentIds(cfg);

      if (!agents.includes(opts.agent)) {
        console.error(`❌ Agent "${opts.agent}" not found in config. Available: ${agents.join(", ")}`);
        process.exit(1);
      }

      const routing = getRouting(cfg);
      const entry: any = {
        agent: opts.agent,
        forward: opts.forward !== "false",
      };
      if (opts.apiKey) entry.apiKey = opts.apiKey;

      const existed = !!routing[name];
      routing[name] = entry;
      setRouting(cfg, routing);
      writeConfig(cfgPath, cfg);

      console.log(`✅ ${existed ? "Updated" : "Added"} route: tell/${name} → agent:${opts.agent}`);
      if (entry.apiKey) console.log(`   API key: ${entry.apiKey.slice(0, 12)}...`);
      console.log(`   Forward: ${entry.forward}`);
      console.log(`\n⚠️  Restart the gateway for changes to take effect:`);
      console.log(`   openclaw gateway restart`);
    });

  /* ── list-routes ── */
  clawtell
    .command("list-routes")
    .description("Show the ClawTell routing table")
    .action(() => {
      const cfg = readConfig(resolveConfigPath());
      const routing = getRouting(cfg);
      const entries = Object.entries(routing);

      if (entries.length === 0) {
        console.log("No routes configured.");
        return;
      }

      console.log("ClawTell Routing Table\n");
      console.log("  Name                     Agent              Forward  API Key");
      console.log("  " + "─".repeat(72));
      for (const [name, route] of entries) {
        const r = route as any;
        const fwd = r.forward !== false ? "yes" : "no";
        const key = r.apiKey ? r.apiKey.slice(0, 12) + "..." : "(account)";
        const label = name === "_default" ? "_default (catch-all)" : `tell/${name}`;
        console.log(`  ${label.padEnd(25)} ${(r.agent ?? "?").padEnd(18)} ${fwd.padEnd(8)} ${key}`);
      }
      console.log();
    });

  /* ── remove-route ── */
  clawtell
    .command("remove-route")
    .description("Remove a ClawTell routing entry")
    .requiredOption("--name <name>", "ClawTell name to remove")
    .action((opts: any) => {
      const name = opts.name.toLowerCase();
      const cfgPath = resolveConfigPath();
      const cfg = readConfig(cfgPath);
      const routing = getRouting(cfg);

      if (!routing[name]) {
        console.error(`❌ No route found for "${name}".`);
        process.exit(1);
      }

      delete routing[name];
      setRouting(cfg, routing);
      writeConfig(cfgPath, cfg);

      console.log(`✅ Removed route: tell/${name}`);
      console.log(`\n⚠️  Restart the gateway for changes to take effect:`);
      console.log(`   openclaw gateway restart`);
    });
}
