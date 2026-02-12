#!/usr/bin/env node

/**
 * ClawTell Channel Plugin — Post-install script
 * 
 * Automatically symlinks the ClawTell SKILL.md into every agent workspace
 * found in the OpenClaw config. This ensures ALL agents (not just the default)
 * get the ClawTell skill with mandatory forwarding rules.
 * 
 * Runs on: npm install -g @dennisdamenace/clawtell-channel
 */

import { readFileSync, mkdirSync, symlinkSync, unlinkSync, existsSync, lstatSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_SOURCE = join(__dirname, '..', 'skills', 'clawtell', 'SKILL.md');

function findOpenClawConfig() {
  const paths = [
    join(homedir(), '.openclaw', 'openclaw.json'),
    join(homedir(), '.clawdbot', 'clawdbot.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function getAgentWorkspaces(config) {
  const workspaces = new Set();
  const defaults = config?.agents?.defaults?.workspace || join(homedir(), 'workspace');
  workspaces.add(defaults);

  const agents = config?.agents?.list || [];
  for (const agent of agents) {
    workspaces.add(agent.workspace || defaults);
  }
  return [...workspaces];
}

function symlinkSkill(workspace) {
  const targetDir = join(workspace, 'skills', 'clawtell');
  const targetFile = join(targetDir, 'SKILL.md');

  try {
    mkdirSync(targetDir, { recursive: true });

    // Remove existing file/symlink
    if (existsSync(targetFile) || lstatSync(targetFile).isSymbolicLink()) {
      unlinkSync(targetFile);
    }
  } catch {
    // lstatSync throws if file doesn't exist at all — that's fine
  }

  try {
    symlinkSync(SKILL_SOURCE, targetFile);
    console.log(`  ✅ ${workspace}/skills/clawtell/SKILL.md → plugin source`);
    return true;
  } catch (err) {
    console.log(`  ⚠️  ${workspace}: ${err.message}`);
    return false;
  }
}

function main() {
  console.log('\n🦞 ClawTell: Installing skill for all agents...\n');

  if (!existsSync(SKILL_SOURCE)) {
    console.log('  ⚠️  SKILL.md not found in plugin package. Skipping.');
    return;
  }

  const configPath = findOpenClawConfig();
  if (!configPath) {
    console.log('  ℹ️  No OpenClaw config found. Skill available at plugin path only.');
    console.log('  ℹ️  If you have multiple agents, symlink skills/clawtell/SKILL.md into each workspace.');
    return;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.log(`  ⚠️  Could not read config: ${err.message}`);
    return;
  }

  const workspaces = getAgentWorkspaces(config);
  console.log(`  Found ${workspaces.length} workspace(s) in ${configPath}\n`);

  let success = 0;
  for (const ws of workspaces) {
    if (symlinkSkill(ws)) success++;
  }

  console.log(`\n  Done: ${success}/${workspaces.length} workspaces linked.\n`);
}

main();
