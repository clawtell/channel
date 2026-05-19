#!/usr/bin/env node
/**
 * ClawTell Channel Plugin — Post-install script
 *
 * Runs on: npm install -g @clawtell/clawtell
 *
 * 1. Symlinks SKILL.md into every agent workspace
 * 2. Detects openclaw installation (any prefix, any path)
 * 3. Auto-heals corrupted openclaw installs (from npm update -g)
 * 4. Patches openclaw.json: adds "clawtell_send" to each routed agent's tools.alsoAllow
 * 5. Restarts the gateway if it was running
 */

import { readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import JSON5 from 'json5';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_SOURCE = join(__dirname, '..', 'skills', 'clawtell', 'SKILL.md');

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
  } catch {
    return null;
  }
}

function findNpmGlobalRoot() {
  return run('npm root -g');
}

function findOpenClawDir() {
  const root = findNpmGlobalRoot();
  if (root) {
    const p = join(root, 'openclaw');
    if (existsSync(p)) return p;
  }
  // Fallback: search common paths
  const fallbacks = [
    join(homedir(), '.npm-global', 'lib', 'node_modules', 'openclaw'),
    '/usr/local/lib/node_modules/openclaw',
    '/usr/lib/node_modules/openclaw',
  ];
  return fallbacks.find(p => existsSync(p)) || null;
}

function findOpenClawBin() {
  const bin = run('which openclaw') || run('command -v openclaw');
  if (bin) return bin;
  const root = findNpmGlobalRoot();
  if (root) {
    const p = join(root, '..', 'bin', 'openclaw');
    if (existsSync(p)) return p;
  }
  return null;
}

function isGatewayRunning() {
  return run('pgrep -f "openclaw.*gateway\\|openclaw-gateway"') !== null ||
         run('systemctl --user is-active openclaw-gateway 2>/dev/null') === 'active';
}

function restartGateway(bin) {
  const cmd = bin || 'openclaw';
  console.log(`  🔄 Restarting gateway (${cmd} gateway restart)...`);
  const result = spawnSync(cmd, ['gateway', 'restart'], { encoding: 'utf8', timeout: 15000 });
  if (result.status === 0) {
    console.log('  ✅ Gateway restarted\n');
  } else {
    // Try systemctl fallback
    const svc = run('systemctl --user restart openclaw-gateway 2>/dev/null');
    if (svc !== null) {
      console.log('  ✅ Gateway restarted via systemctl\n');
    } else {
      console.log('  ⚠️  Could not restart gateway automatically. Run: openclaw gateway restart\n');
    }
  }
}

// ── OpenClaw integrity check + auto-heal ─────────────────────────────────────

function checkAndHealOpenClaw() {
  console.log('\n🔍 Checking OpenClaw installation...');

  const openclawDir = findOpenClawDir();
  const openclawBin = findOpenClawBin();

  if (!openclawDir) {
    console.log('  ℹ️  OpenClaw not found — skipping integrity check.\n');
    return false;
  }

  let corrupted = false;
  let reason = '';

  try {
    const pkg = JSON.parse(readFileSync(join(openclawDir, 'package.json'), 'utf8'));
    const mainFile = join(openclawDir, pkg.main || 'dist/index.js');
    const distDir = join(openclawDir, 'dist');

    if (!existsSync(distDir)) {
      corrupted = true;
      reason = 'dist/ directory missing';
    } else if (!existsSync(mainFile)) {
      corrupted = true;
      reason = `main entry missing: ${mainFile}`;
    } else {
      // Check for orphaned chunk references (the common npm update corruption pattern)
      const mainContent = readFileSync(mainFile, 'utf8');
      const chunkRefs = [...mainContent.matchAll(/import\(['"](\.\/[^'"]+)['"]\)/g)].map(m => m[1]);
      for (const ref of chunkRefs.slice(0, 10)) {
        const refPath = join(openclawDir, 'dist', ref.replace('./', '') + '.js');
        if (!existsSync(refPath) && !existsSync(refPath.replace('.js', ''))) {
          corrupted = true;
          reason = `missing chunk: ${ref}`;
          break;
        }
      }
    }

    if (!corrupted) {
      console.log(`  ✅ OpenClaw v${pkg.version} — OK\n`);
      return false;
    }
  } catch (err) {
    corrupted = true;
    reason = err.message;
  }

  // Warn clearly — do not auto-update, user must decide
  console.error(`\n  ❌ OpenClaw installation appears corrupted: ${reason}`);
  console.error('  ⚠️  This is usually caused by running "npm update -g openclaw".');
  console.error('  ✅ Fix it with a clean reinstall (takes ~30 seconds):');
  console.error('\n     npm install -g openclaw@latest && openclaw gateway restart\n');
  return false;
}

// ── Skill symlinking ──────────────────────────────────────────────────────────

function findOpenClawConfig() {
  const paths = [
    join(homedir(), '.openclaw', 'openclaw.json'),
    join(homedir(), '.clawdbot', 'clawdbot.json'),
  ];
  return paths.find(p => existsSync(p)) || null;
}

function getAgentWorkspaces(config) {
  const workspaces = new Set();
  const defaults = config?.agents?.defaults?.workspace || join(homedir(), 'workspace');
  workspaces.add(defaults);
  for (const agent of (config?.agents?.list || [])) {
    workspaces.add(agent.workspace || defaults);
  }
  return [...workspaces];
}

function symlinkSkill(workspace) {
  const targetDir = join(workspace, 'skills', 'clawtell');
  const targetFile = join(targetDir, 'SKILL.md');
  try {
    mkdirSync(targetDir, { recursive: true });
    try {
      if (existsSync(targetFile) || lstatSync(targetFile).isSymbolicLink()) unlinkSync(targetFile);
    } catch { /* file didn't exist */ }
    symlinkSync(SKILL_SOURCE, targetFile);
    console.log(`  ✅ ${workspace}/skills/clawtell/SKILL.md`);
    return true;
  } catch (err) {
    console.log(`  ⚠️  ${workspace}: ${err.message}`);
    return false;
  }
}

function installSkills() {
  console.log('\n🦞 ClawTell: Linking skill into agent workspaces...\n');
  if (!existsSync(SKILL_SOURCE)) {
    console.log('  ⚠️  SKILL.md not found in plugin. Skipping.\n');
    return;
  }
  const configPath = findOpenClawConfig();
  if (!configPath) {
    console.log('  ℹ️  No OpenClaw config found — skill available at plugin path only.\n');
    return;
  }
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const workspaces = getAgentWorkspaces(config);
    console.log(`  Found ${workspaces.length} workspace(s)\n`);
    let ok = 0;
    for (const ws of workspaces) { if (symlinkSkill(ws)) ok++; }
    console.log(`\n  Done: ${ok}/${workspaces.length} workspaces linked.\n`);
  } catch (err) {
    console.log(`  ⚠️  Could not read config: ${err.message}\n`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

checkAndHealOpenClaw();
installSkills();

// ── dmPolicy check ───────────────────────────────────────────────────────────
// ClawTell forwards messages to Telegram. If any Telegram account used by a
// ClawTell route has dmPolicy:"pairing", forwards will be blocked for unconfigured
// chatIds — OpenClaw's security feature, but it breaks ClawTell delivery by default.

function checkDmPolicy() {
  const configPath = findOpenClawConfig();
  if (!configPath) return;

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { return; }

  const clawtellRouting = config?.channels?.clawtell?.routing || {};
  const telegramAccounts = config?.channels?.telegram?.accounts || {};

  // Only check accounts explicitly named as forwardTo targets in ClawTell routing.
  // "default" and pairing-mode accounts that work via runtime pairings are excluded —
  // we can't inspect runtime pairing state from postinstall.
  const usedAccounts = new Set();
  for (const route of Object.values(clawtellRouting)) {
    const acct = route?.forwardTo?.accountId;
    if (acct && acct !== 'default') usedAccounts.add(acct);
  }
  if (usedAccounts.size === 0) return; // No explicit forwardTo targets — nothing to check

  console.log('\n🔒 Checking Telegram dmPolicy for ClawTell-linked accounts...\n');

  let warned = false;
  for (const [accountId, account] of Object.entries(telegramAccounts)) {
    if (!usedAccounts.has(accountId)) continue;
    // Warn if pairing mode AND no allowlist — user needs to approve themselves to receive forwards
    if (account?.dmPolicy === 'pairing' && !account?.allowFrom?.length) {
      warned = true;
      console.log(`  ⚠️  Account "${accountId}" has dmPolicy: "pairing" (OpenClaw security default).`);
      console.log(`     ClawTell message forwards will be blocked until your chatId is approved.`);
      console.log(`     This is intentional — OpenClaw requires explicit approval for each user.\n`);
      console.log(`  ✅ To approve yourself: send any message to your Telegram bot.`);
      console.log(`     It will show a pairing code. Then run:`);
      console.log(`       openclaw pairing approve telegram <CODE>\n`);
      console.log(`  ℹ️  To see pending requests: openclaw pairing list\n`);
    }
  }

  if (!warned) {
    console.log('  ✅ All ClawTell-linked Telegram accounts allow forwarding\n');
  }
}

checkDmPolicy();

// ── alsoAllow patcher ────────────────────────────────────────────────────────
// OpenClaw v2026.5.x messaging/minimal profiles do not include exec/process
// (PR #75055). The clawtell_send tool replaces the old shell-based send flow,
// but it must be added to each routed agent's tools.alsoAllow to be visible.

function patchAlsoAllow() {
  const configPath = findOpenClawConfig();
  if (!configPath) return;

  if (process.env.CLAWTELL_POSTINSTALL_SKIP === '1') {
    console.log('\n🔧 ClawTell: alsoAllow patcher\n');
    console.log('  ℹ️  CLAWTELL_POSTINSTALL_SKIP=1 — skipping alsoAllow patcher.\n');
    return;
  }

  let raw, config;
  try {
    raw = readFileSync(configPath, 'utf8');
    config = JSON5.parse(raw);
  } catch (err) {
    console.log('\n🔧 ClawTell: alsoAllow patcher\n');
    console.log(`  ⚠️  Could not parse ${configPath} for alsoAllow patch: ${err.message}`);
    console.log(`     Skipping — add "clawtell_send" manually to each routed agent's tools.alsoAllow.\n`);
    return;
  }

  const clawtellCfg = config?.channels?.clawtell;
  if (!clawtellCfg?.enabled) return; // plugin not in use on this gateway

  console.log('\n🔧 ClawTell: alsoAllow patcher\n');

  // Collect target agent ids:
  // - every routing.<name>.agent (excluding _default key, but including _default's agent)
  // - if no routing, fall back to the configured default agent or "main"
  const routing = clawtellCfg.routing ?? {};
  const targetIds = new Set();
  for (const [, entry] of Object.entries(routing)) {
    if (entry?.agent) targetIds.add(entry.agent);
  }
  if (targetIds.size === 0) {
    const defaultId =
      config?.agents?.defaults?.id ??
      config?.agents?.list?.[0]?.id ??
      'main';
    targetIds.add(defaultId);
  }

  const agentList = config?.agents?.list;
  if (!Array.isArray(agentList)) {
    // Single-agent flat config — no per-agent override path exists.
    // The plugin's clawtell_send tool will still be available because no
    // restrictive agents.list[].tools profile is in play.
    console.log('  ℹ️  No agents.list in config — skipping per-agent alsoAllow patch (single-agent flat config).\n');
    return;
  }

  const patched = [];
  const skipped = [];
  for (const id of targetIds) {
    const agent = agentList.find((a) => a?.id === id);
    if (!agent) {
      skipped.push(id);
      continue;
    }
    agent.tools = agent.tools ?? {};
    agent.tools.alsoAllow = agent.tools.alsoAllow ?? [];
    if (agent.tools.alsoAllow.includes('clawtell_send')) continue;
    agent.tools.alsoAllow.push('clawtell_send');
    patched.push(id);
  }

  if (skipped.length > 0) {
    console.log(`  ⚠️  alsoAllow: agent id(s) not found in agents.list — ${skipped.join(', ')} (skipped)`);
  }

  if (patched.length === 0) {
    console.log('  ✅ All routed agents already have "clawtell_send" in tools.alsoAllow.\n');
    return;
  }

  if (process.env.CLAWTELL_POSTINSTALL_DRY_RUN === '1') {
    console.log(`  [DRY-RUN] Would add "clawtell_send" to alsoAllow for: ${patched.join(', ')}`);
    console.log(`     File unchanged. Re-run without CLAWTELL_POSTINSTALL_DRY_RUN=1 to apply.\n`);
    return;
  }

  const backupPath = `${configPath}.bak.${Date.now()}`;
  try {
    writeFileSync(backupPath, raw, 'utf8');
    writeFileSync(configPath, JSON5.stringify(config, null, 2), 'utf8');
    console.log(`  ✅ Added "clawtell_send" to alsoAllow for: ${patched.join(', ')}`);
    console.log(`     Backup: ${backupPath}\n`);
  } catch (err) {
    console.log(`  ⚠️  alsoAllow write failed: ${err.message}`);
    console.log(`     Manual fix: add "clawtell_send" to agents.list[].tools.alsoAllow for: ${patched.join(', ')}\n`);
    return;
  }

  // Restart gateway so the new alsoAllow + new plugin code take effect.
  if (isGatewayRunning()) {
    restartGateway(findOpenClawBin());
  } else {
    console.log('  ℹ️  Gateway not running — no restart needed. Start it with "openclaw gateway start" when ready.\n');
  }
}

patchAlsoAllow();
