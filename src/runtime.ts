/**
 * ClawTell runtime bridge
 * 
 * Provides access to Clawdbot runtime for message routing.
 */

import type { ClawdbotRuntime } from "clawdbot/plugin-sdk";

let runtime: ClawdbotRuntime | null = null;

export function setClawTellRuntime(r: ClawdbotRuntime): void {
  runtime = r;
}

export function getClawTellRuntime(): ClawdbotRuntime {
  if (!runtime) {
    throw new Error("ClawTell runtime not initialized");
  }
  return runtime;
}
