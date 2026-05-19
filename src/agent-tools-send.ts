/**
 * ClawTell native send tool — `clawtell_send`
 *
 * Channel-owned agent tool that sends a ClawTell message via the existing
 * `sendClawTellMessage` HTTP path. Replaces the shell-based curl flow that
 * stopped working on OpenClaw v2026.5.x messaging/minimal tool profiles
 * (PR #75055 removed implicit exec/process grants).
 *
 * Wired into the plugin via `ChannelPlugin.agentTools` in channel.ts.
 * Per-agent enablement happens in scripts/postinstall.js, which adds
 * "clawtell_send" to each routed agent's tools.alsoAllow list.
 *
 * Per-route key resolution: when `from` is provided AND a matching routing
 * entry has its own apiKey, that key is used (so multi-name accounts send
 * as the correct identity). Otherwise falls back to the account-level key.
 */

import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { Type } from "typebox";
import { sendClawTellMessage } from "./send.js";
import { resolveClawTellAccount } from "./channel.js";

// Return type is inferred from the object literal so TypeScript can match
// it against openclaw's `ChannelAgentTool` structurally. The dedicated
// `openclaw/plugin-sdk/channel-contract` subpath that ships
// `ChannelAgentTool` as a named export was only added in 2026.5.x; this
// plugin still builds against the older devDependency, and the runtime
// gateway accepts the object structurally either way.
export function createClawTellSendTool(params: {
  cfg?: ClawdbotConfig;
}) {
  return {
    name: "clawtell_send",
    label: "ClawTell Send",
    ownerOnly: true,
    description:
      "Send a message via ClawTell to another agent (tell/<name>). " +
      "After the call succeeds, summarize the send in the current chat " +
      "(e.g. '✓ Sent to tell/<name>') so the human has visibility. " +
      "If the user did not specify content verbatim, compose the message " +
      "naturally in your own words.",
    parameters: Type.Object({
      to: Type.String({
        description: "Recipient name (without the tell/ prefix)",
      }),
      body: Type.String({
        description: "Message body",
      }),
      subject: Type.Optional(
        Type.String({ description: "Brief topic, 3-5 words" }),
      ),
      replyToId: Type.Optional(
        Type.String({ description: "Original message id when replying" }),
      ),
      from: Type.Optional(
        Type.String({
          description:
            "Your tell/ name. Required on multi-name accounts so the recipient sees the correct sender; on single-name gateways the account's name is used automatically.",
        }),
      ),
      accountId: Type.Optional(
        Type.String({
          description:
            "ClawTell account id. Omit on single-account gateways; required only when channels.clawtell.accounts is configured.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const a = args as {
        to?: string;
        body?: string;
        subject?: string;
        replyToId?: string;
        from?: string;
        accountId?: string;
      };

      if (!a.to || !a.body) {
        return {
          content: [
            {
              type: "text",
              text: "× Send failed: 'to' and 'body' are required.",
            },
          ],
          details: { ok: false, reason: "missing_required_args" },
        };
      }

      const cfg = params.cfg;
      if (!cfg) {
        return {
          content: [
            {
              type: "text",
              text: "× Send failed: gateway config not available at tool factory time.",
            },
          ],
          details: { ok: false, reason: "no_cfg" },
        };
      }

      const account = resolveClawTellAccount({
        cfg,
        accountId: a.accountId,
      });

      // Resolve sender identity + key. If `from` matches a routing entry
      // with its own apiKey, use the per-route key (Scenario 2). Otherwise
      // fall back to the account-level key and account.tellName.
      let apiKey: string | null = account.apiKey;
      let fromName: string | undefined = account.tellName ?? undefined;

      if (a.from) {
        const cleanFrom = a.from.replace(/^tell\//, "").toLowerCase();
        fromName = cleanFrom;
        const route = account.routing?.[cleanFrom];
        if (route?.apiKey) {
          apiKey = route.apiKey;
        }
      }

      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "× Send failed: ClawTell API key not configured for this account.",
            },
          ],
          details: { ok: false, reason: "no_api_key", accountId: account.accountId },
        };
      }

      const cleanTo = a.to.replace(/^tell\//, "").toLowerCase();

      const result = await sendClawTellMessage({
        apiKey,
        to: cleanTo,
        body: a.body,
        subject: a.subject,
        replyToId: a.replyToId,
        fromName,
      });

      if (!result.ok) {
        const msg = result.error?.message ?? "unknown error";
        return {
          content: [{ type: "text", text: `× Send failed: ${msg}` }],
          details: {
            ok: false,
            error: msg,
            retryCount: result.retryCount,
            from: fromName,
            to: cleanTo,
          },
        };
      }

      if (result.status === "pending_approval") {
        return {
          content: [
            {
              type: "text",
              text: `… Queued for approval — tell/${cleanTo} will see it when their owner approves.`,
            },
          ],
          details: {
            ok: true,
            status: "pending_approval",
            messageId: result.messageId,
            from: fromName,
            to: cleanTo,
          },
        };
      }

      return {
        content: [
          { type: "text", text: `✓ Sent to tell/${cleanTo}` },
        ],
        details: {
          ok: true,
          status: result.status ?? "sent",
          messageId: result.messageId,
          from: fromName,
          to: cleanTo,
        },
      };
    },
  };
}
