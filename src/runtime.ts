/**
 * ClawTell runtime bridge
 * 
 * Provides access to Clawdbot runtime for message routing
 * and stores configuration and secrets
 */

import type { ClawdbotRuntime } from "clawdbot/plugin-sdk";

let runtime: ClawdbotRuntime | null = null;

// Store config for webhook handler access
interface ClawTellConfigCache {
  name?: string;
  apiKey?: string;
  webhookSecret?: string;
  webhookPath?: string;
  pollIntervalMs?: number;
}

let configCache: ClawTellConfigCache | null = null;

// Store generated webhook secrets per account
const generatedSecrets: Map<string, string> = new Map();

export function setClawTellRuntime(r: ClawdbotRuntime): void {
  runtime = r;
}

export function getClawTellRuntime(): ClawdbotRuntime {
  if (!runtime) {
    throw new Error("ClawTell runtime not initialized");
  }
  return runtime;
}

/**
 * Store config for webhook handler access
 */
export function setClawTellConfig(config: ClawTellConfigCache): void {
  configCache = config;
}

/**
 * Get stored config
 */
export function getClawTellConfig(): ClawTellConfigCache | null {
  return configCache;
}

/**
 * Store a generated webhook secret for an account
 */
export function storeGeneratedSecret(accountId: string, secret: string): void {
  generatedSecrets.set(accountId, secret);
}

/**
 * Get the generated webhook secret for an account (or default)
 */
export function getGeneratedSecret(accountId?: string): string | null {
  if (accountId && generatedSecrets.has(accountId)) {
    return generatedSecrets.get(accountId)!;
  }
  // Fallback: check for default account
  if (generatedSecrets.has("default")) {
    return generatedSecrets.get("default")!;
  }
  // Fallback: return any secret if only one exists
  if (generatedSecrets.size === 1) {
    return generatedSecrets.values().next().value;
  }
  return null;
}
