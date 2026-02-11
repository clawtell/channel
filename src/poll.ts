/**
 * ClawTell inbox polling
 * 
 * Supports two modes:
 * 1. Legacy single-name polling (GET /api/messages/poll)
 * 2. Account-level polling (GET /api/messages/poll-account) - polls ALL names
 * 
 * Account-level mode routes messages by to_name → routing config → target agent.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import type { ResolvedClawTellAccount, ClawTellRouteEntry } from "./channel.js";
import { getClawTellRuntime, type ClawTellRuntime } from "./runtime.js";
import { enqueue, dequeue, markAttempt, getPending, type QueuedMessage } from "./queue.js";

const CLAWTELL_API_BASE = "https://www.clawtell.com/api";

interface ClawTellMessage {
  id: string;
  from: string;
  to_name?: string;
  subject: string;
  body: string;
  createdAt: string;
  replyToMessageId?: string;
  threadId?: string;
  attachments?: unknown[];
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
 * Read delivery context from sessions.json for a given agent
 */
async function getDeliveryContext(agentName: string = "main"): Promise<DeliveryContext | null> {
  try {
    const sessionsPath = path.join(
      process.env.HOME || "/home/claw",
      ".clawdbot",
      "agents",
      agentName,
      "sessions",
      "sessions.json"
    );
    
    const data = JSON.parse(await fs.readFile(sessionsPath, "utf8"));
    const mainSession = data[`agent:${agentName}:main`];
    const dc = mainSession?.deliveryContext;
    
    if (dc?.channel && dc?.to) {
      return {
        channel: dc.channel,
        to: dc.to,
        accountId: dc.accountId || "default"
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Forward message to human's active channel
 */
async function forwardToActiveChannel(
  runtime: ClawTellRuntime,
  messageContent: string,
  config: ClawdbotConfig,
  agentName: string = "main"
): Promise<void> {
  const dc = await getDeliveryContext(agentName);
  
  if (!dc) {
    console.log(`[ClawTell] No active delivery context for agent=${agentName}, skipping forward`);
    return;
  }
  
  console.log(`[ClawTell] Forwarding to ${dc.channel}: ${dc.to} (agent=${agentName})`);
  const sendOpts = { accountId: dc.accountId || "default" };
  
  try {
    switch (dc.channel) {
      case "telegram":
        if (runtime.channel?.telegram?.sendMessageTelegram) {
          await runtime.channel.telegram.sendMessageTelegram(dc.to, messageContent, sendOpts);
        } else {
          const telegramConfig = (config.channels as any)?.telegram;
          const account = telegramConfig?.accounts?.[dc.accountId || "default"] || telegramConfig;
          const botToken = account?.botToken;
          if (botToken) {
            const chatId = dc.to.replace(/^telegram:/, "");
            const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: messageContent, parse_mode: "Markdown" }),
              signal: AbortSignal.timeout(10000),
            });
            const result = await resp.json();
            if (!result.ok) console.error("[ClawTell] Telegram API error:", result.description);
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
  } catch (err) {
    console.error("[ClawTell] Forward failed:", err);
  }
}

// ============================================================================
// Legacy single-name polling (inbox-based)
// ============================================================================

async function fetchInbox(
  apiKey: string,
  opts?: { unreadOnly?: boolean; limit?: number }
): Promise<ClawTellMessage[]> {
  const { unreadOnly = true, limit = 50 } = opts ?? {};
  const params = new URLSearchParams();
  if (unreadOnly) params.set("unread", "true");
  params.set("limit", String(limit));
  
  const response = await fetch(`${CLAWTELL_API_BASE}/messages/inbox?${params}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  
  if (!response.ok) throw new Error(`Failed to fetch inbox: HTTP ${response.status}`);
  const data = await response.json();
  return data.messages ?? [];
}

async function markAsRead(apiKey: string, messageId: string): Promise<void> {
  await fetch(`${CLAWTELL_API_BASE}/messages/${messageId}/read`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
}

// ============================================================================
// Account-level polling
// ============================================================================

async function pollAccountMessages(
  apiKey: string,
  opts?: { limit?: number; timeout?: number }
): Promise<ClawTellMessage[]> {
  const { limit = 50, timeout = 5 } = opts ?? {};
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("timeout", String(timeout));
  
  const response = await fetch(`${CLAWTELL_API_BASE}/messages/poll-account?${params}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${apiKey}` },
    signal: AbortSignal.timeout((timeout + 5) * 1000),
  });
  
  if (!response.ok) throw new Error(`Failed to poll account: HTTP ${response.status}`);
  const data = await response.json();
  return data.messages ?? [];
}

async function batchAck(apiKey: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  await fetch(`${CLAWTELL_API_BASE}/messages/ack`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messageIds }),
    signal: AbortSignal.timeout(10000),
  });
}

/**
 * Resolve route for a to_name
 */
function resolveRoute(toName: string, account: ResolvedClawTellAccount): ClawTellRouteEntry {
  const routing = account.routing;
  
  // Exact match
  if (routing[toName]) return routing[toName];
  
  // _default fallback
  if (routing["_default"]) return routing["_default"];
  
  // Ultimate fallback: main agent, forward
  return { agent: "main", forward: true };
}

// ============================================================================
// Main poll loop
// ============================================================================

export async function pollClawTellInbox(opts: PollOptions): Promise<void> {
  const { account, abortSignal, statusSink } = opts;
  
  console.log(`[ClawTell Poll] Starting for account: ${account.accountId}, pollAccount: ${account.pollAccount}`);
  
  if (!account.apiKey) {
    throw new Error("ClawTell API key not configured");
  }
  
  const pollIntervalMs = account.pollIntervalMs;
  const apiKey = account.apiKey;
  const runtime = getClawTellRuntime();
  
  statusSink({ running: true, lastStartAt: new Date().toISOString() });
  
  if (account.pollAccount) {
    await pollAccountLoop(opts, runtime, apiKey, pollIntervalMs);
  } else {
    await pollLegacyLoop(opts, runtime, apiKey, pollIntervalMs);
  }
  
  statusSink({ running: false, lastStopAt: new Date().toISOString() });
}

/**
 * Dispatch a message to an agent session. Returns true on success.
 */
async function dispatchToAgent(
  runtime: ClawTellRuntime,
  opts: PollOptions,
  apiKey: string,
  params: {
    msgId: string;
    senderName: string;
    toName: string;
    agentName: string;
    messageContent: string;
    rawBody: string;
    subject?: string;
    createdAt: string;
    replyToMessageId?: string;
  }
): Promise<boolean> {
  try {
    const sessionKey = `agent:${params.agentName}:main`;
    
    const inboundCtx = runtime.channel.reply.finalizeInboundContext({
      Body: params.messageContent,
      RawBody: params.rawBody,
      From: `tell/${params.senderName}`,
      To: `tell/${params.toName}`,
      SessionKey: sessionKey,
      AccountId: opts.account.accountId,
      ChatType: "direct",
      SenderName: params.senderName,
      SenderId: `tell/${params.senderName}`,
      Provider: "clawtell",
      Surface: "clawtell",
      MessageSid: params.msgId,
      Timestamp: new Date(params.createdAt),
      ReplyToId: params.replyToMessageId,
      Subject: params.subject,
    });
    
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: inboundCtx,
      cfg: opts.config,
      dispatcherOptions: {
        deliver: async (payload: any) => {
          console.log(`[ClawTell] Sending reply from ${params.toName} to ${params.senderName}`);
          await fetch(`${CLAWTELL_API_BASE}/messages/send`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              to: params.senderName,
              body: payload.text || payload.content,
              subject: payload.subject,
              from_name: params.toName,
            }),
            signal: AbortSignal.timeout(30000),
          });
        },
        onError: (err: Error) => {
          console.error("[ClawTell] Reply delivery error:", err);
        },
      },
    });
    
    return true;
  } catch (err) {
    console.error(`[ClawTell] Dispatch failed for msg ${params.msgId}:`, err);
    return false;
  }
}

/**
 * Account-level polling loop (with local queue for failed dispatches)
 */
async function pollAccountLoop(
  opts: PollOptions,
  runtime: ClawTellRuntime,
  apiKey: string,
  pollIntervalMs: number
): Promise<void> {
  const { account, abortSignal, statusSink } = opts;
  
  while (!abortSignal.aborted) {
    // ── Phase 3: Retry queued messages first ──
    try {
      const queued = await getPending();
      for (const qm of queued) {
        if (abortSignal.aborted) break;
        
        const ok = await dispatchToAgent(runtime, opts, qm.apiKey, {
          msgId: qm.id,
          senderName: qm.from,
          toName: qm.toName,
          agentName: qm.agent,
          messageContent: qm.content,
          rawBody: qm.rawBody,
          subject: qm.subject,
          createdAt: qm.createdAt,
          replyToMessageId: qm.replyToMessageId,
        });
        
        if (ok) {
          // ACK on server now that dispatch succeeded
          try {
            await batchAck(qm.apiKey, [qm.id]);
            console.log(`[ClawTell Queue] Delivered queued msg ${qm.id} to agent:${qm.agent}, ACK'd`);
          } catch (err) {
            console.error(`[ClawTell Queue] ACK failed for dequeued msg ${qm.id}:`, err);
          }
          await dequeue(qm.id);
        } else {
          const deadLettered = await markAttempt(qm.id, "dispatch failed on retry");
          if (deadLettered) {
            // Notify main agent about dead-lettered message
            try {
              await forwardToActiveChannel(
                runtime,
                `⚠️ **ClawTell Dead Letter**: Message ${qm.id} from tell/${qm.from} → ${qm.toName} failed after ${qm.attempts} attempts. Last error: ${qm.lastError}`,
                opts.config,
                "main"
              );
            } catch { /* best effort */ }
            // ACK to prevent server-side buildup
            try { await batchAck(qm.apiKey, [qm.id]); } catch { /* best effort */ }
          }
        }
      }
    } catch (err) {
      console.error("[ClawTell Queue] Error processing queued messages:", err);
    }
    
    // ── Poll server for new messages ──
    try {
      const messages = await pollAccountMessages(apiKey, { limit: 50, timeout: 5 });
      const ackedIds: string[] = [];
      
      for (const msg of messages) {
        const senderName = (msg.from || "").replace(/^tell\//, "");
        const toName = msg.to_name || account.tellName || "";
        
        // Check delivery policy
        const deliveryCheck = checkDeliveryPolicy(senderName, opts.config);
        if (!deliveryCheck.allowed) {
          console.log(`[ClawTell] Rejecting message from ${senderName}: ${deliveryCheck.reason}`);
          ackedIds.push(msg.id);
          continue;
        }
        
        // Resolve routing
        const route = resolveRoute(toName, account);
        const agentName = route.agent || "main";
        
        console.log(`[ClawTell] Message ${msg.id}: ${senderName} → ${toName} → agent:${agentName} (forward:${route.forward})`);
        
        // Format message
        const messageContent = msg.subject
          ? `🦞🦞 ClawTell Delivery 🦞🦞\nfrom tell/${senderName} (to: ${toName})\n**Subject:** ${msg.subject}\n\n${msg.body}`
          : `🦞🦞 ClawTell Delivery 🦞🦞\nfrom tell/${senderName} (to: ${toName})\n\n${msg.body}`;
        
        // Forward to human's active channel if configured
        if (route.forward) {
          try {
            await forwardToActiveChannel(runtime, messageContent, opts.config, agentName);
          } catch (err) {
            console.error("[ClawTell] Forward failed:", err);
          }
        }
        
        // Dispatch to agent session
        const ok = await dispatchToAgent(runtime, opts, apiKey, {
          msgId: msg.id,
          senderName,
          toName,
          agentName,
          messageContent,
          rawBody: msg.body,
          subject: msg.subject,
          createdAt: msg.createdAt,
          replyToMessageId: msg.replyToMessageId,
        });
        
        if (ok) {
          ackedIds.push(msg.id);
        } else if (agentName !== "main") {
          // Queue for retry (never queue messages to main — main is always running)
          await enqueue({
            id: msg.id,
            from: senderName,
            toName,
            agent: agentName,
            forward: route.forward,
            content: messageContent,
            rawBody: msg.body,
            subject: msg.subject,
            createdAt: msg.createdAt,
            queuedAt: new Date().toISOString(),
            attempts: 1,
            lastError: "initial dispatch failed",
            accountId: account.accountId,
            apiKey,
            replyToMessageId: msg.replyToMessageId,
          });
          // ACK on server — we own delivery now via local queue
          ackedIds.push(msg.id);
        }
        // If main agent dispatch fails, don't ACK — server will retry next poll
      }
      
      // Batch ACK successful messages
      if (ackedIds.length > 0) {
        try {
          await batchAck(apiKey, ackedIds);
          console.log(`[ClawTell] ACK'd ${ackedIds.length} messages`);
        } catch (err) {
          console.error("[ClawTell] Batch ACK failed:", err);
        }
      }
      
      if (messages.length > 0) {
        statusSink({ lastInboundAt: new Date().toISOString() });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("[ClawTell] Account poll error:", errorMsg);
      statusSink({ lastError: errorMsg });
    }
    
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, pollIntervalMs);
      abortSignal.addEventListener("abort", () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
  }
}

/**
 * Legacy single-name polling loop (unchanged behavior)
 */
async function pollLegacyLoop(
  opts: PollOptions,
  runtime: ClawTellRuntime,
  apiKey: string,
  pollIntervalMs: number
): Promise<void> {
  const { account, abortSignal, statusSink } = opts;
  const processedIds = new Set<string>();
  
  while (!abortSignal.aborted) {
    try {
      const messages = await fetchInbox(apiKey, { unreadOnly: true });
      
      for (const msg of messages) {
        if (processedIds.has(msg.id)) continue;
        processedIds.add(msg.id);
        
        if (processedIds.size > 1000) {
          const idsArray = Array.from(processedIds);
          processedIds.clear();
          for (const id of idsArray.slice(-500)) processedIds.add(id);
        }
        
        const senderName = (msg.from || "").replace(/^tell\//, "");
        
        const deliveryCheck = checkDeliveryPolicy(senderName, opts.config);
        if (!deliveryCheck.allowed) {
          console.log(`[ClawTell] Rejecting message from ${senderName}: ${deliveryCheck.reason}`);
          await markAsRead(apiKey, msg.id);
          continue;
        }
        
        const canAutoReply = isAutoReplyAllowed(senderName, opts.config);
        console.log(`[ClawTell] Auto-reply for ${senderName}: ${canAutoReply ? 'ALLOWED' : 'WAIT FOR HUMAN'}`);
        
        const messageContent = msg.subject
          ? `🦞🦞 ClawTell Delivery 🦞🦞\nfrom tell/${senderName}\n**Subject:** ${msg.subject}\n\n${msg.body}`
          : `🦞🦞 ClawTell Delivery 🦞🦞\nfrom tell/${senderName}\n\n${msg.body}`;
        
        try {
          await forwardToActiveChannel(runtime, messageContent, opts.config);
        } catch (err) {
          console.error("[ClawTell] Forward failed:", err);
        }
        
        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
          Body: messageContent,
          RawBody: msg.body,
          From: `tell/${senderName}`,
          To: `tell/${account.tellName}`,
          SessionKey: `agent:main:main`,
          AccountId: account.accountId,
          ChatType: "direct",
          SenderName: senderName,
          SenderId: `tell/${senderName}`,
          Provider: "clawtell",
          Surface: "clawtell",
          MessageSid: msg.id,
          Timestamp: new Date(msg.createdAt),
          ReplyToId: msg.replyToMessageId,
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
    
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, pollIntervalMs);
      abortSignal.addEventListener("abort", () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
  }
}
