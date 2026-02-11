/**
 * ClawTell inbox polling
 * 
 * Polls the ClawTell inbox for new messages and forwards them to the human's
 * active channel (Telegram/Discord/etc.) with 🦞 prefix, then dispatches to
 * the agent session for processing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import type { ResolvedClawTellAccount } from "./channel.js";
import { getClawTellRuntime, type ClawTellRuntime } from "./runtime.js";

const CLAWTELL_API_BASE = "https://www.clawtell.com/api";

interface ClawTellMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  read: boolean;
  auto_reply_eligible: boolean;
  created_at: string;
  reply_to_id?: string;
  thread_id?: string;
}

interface PollOptions {
  account: ResolvedClawTellAccount;
  config: ClawdbotConfig;
  abortSignal: AbortSignal;
  statusSink: (patch: Record<string, unknown>) => void;
}

interface DeliveryContext {
  channel: string;
  to: string;
  accountId?: string;
}

/**
 * Check if sender passes delivery policy
 */
function checkDeliveryPolicy(sender: string, config: ClawdbotConfig): { allowed: boolean; reason?: string } {
  const ctConfig = (config.channels as any)?.clawtell ?? {};
  const policy = ctConfig.deliveryPolicy ?? "everyone";
  const normalizedSender = sender.toLowerCase().replace(/^tell\//, "");
  
  switch (policy) {
    case "everyone": {
      const blocklist: string[] = ctConfig.deliveryBlocklist ?? [];
      if (blocklist.map((s: string) => s.toLowerCase()).includes(normalizedSender)) {
        return { allowed: false, reason: "sender on blocklist" };
      }
      return { allowed: true };
    }
    case "allowlist": {
      const allowlist: string[] = ctConfig.deliveryAllowlist ?? [];
      if (allowlist.map((s: string) => s.toLowerCase()).includes(normalizedSender)) {
        return { allowed: true };
      }
      return { allowed: false, reason: "sender not on allowlist" };
    }
    case "blocklist": {
      const blocklistOnly: string[] = ctConfig.deliveryBlocklist ?? [];
      if (blocklistOnly.map((s: string) => s.toLowerCase()).includes(normalizedSender)) {
        return { allowed: false, reason: "sender on blocklist" };
      }
      return { allowed: true };
    }
    default:
      return { allowed: true };
  }
}

/**
 * Check if sender is on auto-reply allowlist
 */
function isAutoReplyAllowed(sender: string, config: ClawdbotConfig): boolean {
  const ctConfig = (config.channels as any)?.clawtell ?? {};
  const allowlist: string[] = ctConfig.autoReplyAllowlist ?? [];
  const normalizedSender = sender.toLowerCase().replace(/^tell\//, "");
  return allowlist.map((s: string) => s.toLowerCase()).includes(normalizedSender);
}

/**
 * Read delivery context from sessions.json
 */
async function getDeliveryContext(): Promise<DeliveryContext | null> {
  try {
    const sessionsPath = path.join(
      process.env.HOME || "/home/claw",
      ".clawdbot",
      "agents",
      "main",
      "sessions",
      "sessions.json"
    );
    
    const data = JSON.parse(await fs.readFile(sessionsPath, "utf8"));
    const mainSession = data["agent:main:main"];
    const dc = mainSession?.deliveryContext;
    
    if (dc?.channel && dc?.to) {
      return {
        channel: dc.channel,
        to: dc.to,
        accountId: dc.accountId || "default"
      };
    }
    return null;
  } catch (err) {
    console.error("[ClawTell] Failed to read delivery context:", err);
    return null;
  }
}

/**
 * Forward message to human's active channel
 */
async function forwardToActiveChannel(
  runtime: ClawTellRuntime,
  messageContent: string,
  config: ClawdbotConfig
): Promise<void> {
  const dc = await getDeliveryContext();
  
  if (!dc) {
    console.log("[ClawTell] No active delivery context, skipping forward");
    return;
  }
  
  console.log(`[ClawTell] Forwarding to ${dc.channel}: ${dc.to}`);
  const sendOpts = { accountId: dc.accountId || "default" };
  
  try {
    switch (dc.channel) {
      case "telegram":
        if (runtime.channel?.telegram?.sendMessageTelegram) {
          await runtime.channel.telegram.sendMessageTelegram(dc.to, messageContent, sendOpts);
        } else {
          // Fallback: direct API call
          const telegramConfig = (config.channels as any)?.telegram;
          const account = telegramConfig?.accounts?.[dc.accountId || "default"] || telegramConfig;
          const botToken = account?.botToken;
          if (botToken) {
            const chatId = dc.to.replace(/^telegram:/, "");
            const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: messageContent,
                parse_mode: "Markdown",
              }),
              signal: AbortSignal.timeout(10000),
            });
            const result = await resp.json();
            if (!result.ok) {
              console.error("[ClawTell] Telegram API error:", result.description);
            }
          }
        }
        break;
      case "discord":
        if (runtime.channel?.discord?.sendMessageDiscord) {
          await runtime.channel.discord.sendMessageDiscord(dc.to, messageContent, sendOpts);
        }
        break;
      case "slack":
        if (runtime.channel?.slack?.sendMessageSlack) {
          await runtime.channel.slack.sendMessageSlack(dc.to, messageContent, sendOpts);
        }
        break;
      case "signal":
        if (runtime.channel?.signal?.sendMessageSignal) {
          await runtime.channel.signal.sendMessageSignal(dc.to, messageContent, sendOpts);
        }
        break;
      case "whatsapp":
        if (runtime.channel?.whatsapp?.sendMessageWhatsApp) {
          await runtime.channel.whatsapp.sendMessageWhatsApp(dc.to, messageContent, sendOpts);
        }
        break;
      default:
        console.log(`[ClawTell] Channel "${dc.channel}" forwarding not yet supported`);
    }
    console.log("[ClawTell] Message forwarded successfully");
  } catch (err) {
    console.error("[ClawTell] Forward failed:", err);
  }
}

async function fetchInbox(
  apiKey: string,
  opts?: { unreadOnly?: boolean; limit?: number }
): Promise<ClawTellMessage[]> {
  const { unreadOnly = true, limit = 50 } = opts ?? {};
  
  const params = new URLSearchParams();
  if (unreadOnly) params.set("unread", "true");
  params.set("limit", String(limit));
  
  const url = `${CLAWTELL_API_BASE}/messages/inbox?${params}`;
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(30000),
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch inbox: HTTP ${response.status}`);
  }
  
  const data = await response.json();
  return data.messages ?? [];
}

async function markAsRead(apiKey: string, messageId: string): Promise<void> {
  await fetch(`${CLAWTELL_API_BASE}/messages/${messageId}/read`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(10000),
  });
}

export async function pollClawTellInbox(opts: PollOptions): Promise<void> {
  const { account, abortSignal, statusSink } = opts;
  
  console.log("[ClawTell Poll] Starting for account:", account.accountId);
  
  if (!account.apiKey) {
    throw new Error("ClawTell API key not configured");
  }
  
  const pollIntervalMs = account.pollIntervalMs;
  const apiKey = account.apiKey;
  
  const runtime = getClawTellRuntime();
  
  statusSink({ running: true, lastStartAt: new Date().toISOString() });
  
  // Track processed message IDs to avoid duplicates
  const processedIds = new Set<string>();
  
  while (!abortSignal.aborted) {
    try {
      const messages = await fetchInbox(apiKey, { unreadOnly: true });
      
      for (const msg of messages) {
        // Skip if already processed
        if (processedIds.has(msg.id)) continue;
        processedIds.add(msg.id);
        
        // Cap the set size
        if (processedIds.size > 1000) {
          const idsArray = Array.from(processedIds);
          processedIds.clear();
          for (const id of idsArray.slice(-500)) {
            processedIds.add(id);
          }
        }
        
        const senderName = msg.from.replace(/^tell\//, "");
        
        // Check delivery policy
        const deliveryCheck = checkDeliveryPolicy(senderName, opts.config);
        if (!deliveryCheck.allowed) {
          console.log(`[ClawTell] Rejecting message from ${senderName}: ${deliveryCheck.reason}`);
          await markAsRead(apiKey, msg.id);
          continue;
        }
        
        // Check auto-reply allowlist
        const canAutoReply = isAutoReplyAllowed(senderName, opts.config);
        console.log(`[ClawTell] Auto-reply for ${senderName}: ${canAutoReply ? 'ALLOWED' : 'WAIT FOR HUMAN'}`);
        
        // Format message with 🦞 prefix for visibility
        const messageContent = msg.subject
          ? `🦞 **ClawTell from tell/${senderName}**\n**Subject:** ${msg.subject}\n\n${msg.body}`
          : `🦞 **ClawTell from tell/${senderName}**\n\n${msg.body}`;
        
        // Forward to human's active channel (Telegram/Discord/etc.)
        try {
          await forwardToActiveChannel(runtime, messageContent, opts.config);
        } catch (err) {
          console.error("[ClawTell] Forward failed:", err);
        }
        
        // Also dispatch to agent session for processing/auto-reply
        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
          Body: messageContent,
          RawBody: msg.body,
          From: `tell/${senderName}`,
          To: `tell/${account.tellName}`,
          SessionKey: `agent:main:main`,  // Route to main session
          AccountId: account.accountId,
          ChatType: "direct",
          SenderName: senderName,
          SenderId: `tell/${senderName}`,
          Provider: "clawtell",
          Surface: "clawtell",
          MessageSid: msg.id,
          Timestamp: new Date(msg.created_at),
          ReplyToId: msg.reply_to_id,
          ThreadId: msg.thread_id,
          Subject: msg.subject,
        });
        
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: inboundCtx,
          cfg: opts.config,
          dispatcherOptions: {
            deliver: async (payload: any) => {
              console.log("[ClawTell] Sending reply back to", senderName);
              await fetch(`${CLAWTELL_API_BASE}/messages`, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  to: senderName,
                  body: payload.text || payload.content,
                  subject: payload.subject,
                  reply_to_id: msg.id,
                }),
                signal: AbortSignal.timeout(30000),
              });
            },
            onError: (err: Error) => {
              console.error("[ClawTell] Reply delivery error:", err);
            },
          },
        });
        
        await markAsRead(apiKey, msg.id);
        statusSink({ lastInboundAt: new Date().toISOString() });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("[ClawTell] Poll error:", errorMsg);
      statusSink({ lastError: errorMsg });
    }
    
    // Wait for next poll cycle
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, pollIntervalMs);
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  }
  
  statusSink({ running: false, lastStopAt: new Date().toISOString() });
}
