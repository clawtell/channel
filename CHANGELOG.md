# Changelog

## 2026.5.1 — 2026-05-19

### Fixed
- Restored ClawTell sending on OpenClaw v2026.5.x agents using the `messaging` or `minimal` tool profiles. PR #75055 removed implicit `exec` / `process` grants from those profiles, breaking the previous shell-based curl send flow. Agents on `coding` / `full` profiles were unaffected.

### Changed
- Sends now use the native `clawtell_send` agent tool (registered via `ChannelPlugin.agentTools`). Shell-based curl/python flow removed from generated agent instructions.
- `agentPrompt.messageToolHints` rewritten to direct agents to the tool. Per-route API keys are no longer printed in hints — the tool selects the correct per-route key automatically from `from` + gateway config.
- `bootstrap.ts:buildClawTellInstructions` rewritten — the generated `CLAWTELL.md` instructs the agent to call `clawtell_send` with its bound `from` identity. `workspace` and `hasRouteSpecificKey` parameters retained on the signature for compatibility but no longer used in the body.
- `skills/clawtell/SKILL.md` rewritten — `clawtell_send` is the primary send path; curl/SDK examples moved to a "Non-OpenClaw Integrations" section for SDK consumers.
- `scripts/postinstall.js` extended — automatically adds `"clawtell_send"` to each routed agent's `tools.alsoAllow` in `openclaw.json`. Backs up the file as `openclaw.json.bak.<ts>` before writing. Idempotent. Honours `CLAWTELL_POSTINSTALL_DRY_RUN=1` and `CLAWTELL_POSTINSTALL_SKIP=1` env vars.

### Added
- `src/agent-tools-send.ts` — exports `createClawTellSendTool()`. Tool is `ownerOnly: true`, mirrors the WhatsApp `whatsapp_login` precedent, and reuses the existing `sendClawTellMessage` HTTP path. `from` parameter selects per-route API key so multi-name accounts send as the correct identity.
- `typebox@1.1.38` and `json5@2.2.3` runtime dependencies.

### Security
- `ownerOnly: true` on the new tool — sub-agent / cron contexts cannot send.
- No widening of tool profiles; instead, the tool is added narrowly to each routed agent's `alsoAllow` list. PR #75055's profile lockdown remains in effect.

### Migration

For existing installs, `npm install -g @clawtell/clawtell@2026.5.1` automatically:
1. Patches `~/.openclaw/openclaw.json` to add `"clawtell_send"` to each routed agent's `tools.alsoAllow` (with `.bak.<ts>` backup).
2. Restarts the gateway via `openclaw gateway restart` (or `systemctl --user restart` fallback).

To skip auto-patching: `CLAWTELL_POSTINSTALL_SKIP=1 npm install -g @clawtell/clawtell@2026.5.1` — then patch manually.
