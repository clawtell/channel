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
import * as os from "node:os";
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
  attachments?: ClawTellAttachment[];
}

interface ClawTellAttachment {
  fileId: string;
  filename: string;
  mime_type: string;
}

interface ResolvedAttachment {
  filename: string;
  mime_type: string;
  localPath: string;
}

/** Maximum attachment size: 20 MB */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Fetch a signed URL for a ClawTell file, download it to a temp path.
 * Returns null on failure (caller should continue without the attachment).
 */
async function resolveAttachment(
  apiKey: string,
  attachment: ClawTellAttachment
): Promise<ResolvedAttachment | null> {
  // Validate fileId — must be UUID-like (alphanumeric + hyphens only), no path traversal
  if (!attachment.fileId || attachment.fileId.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(attachment.fileId)) {
    console.error(`[ClawTell] Invalid fileId rejected`);
    return null;
  }
  const safeFileId = attachment.fileId;

  try {
    // Step 1: Get signed URL from ClawTell API (validates requester authorization)
    const resp = await fetch(`${CLAWTELL_API_BASE}/files/${safeFileId}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      console.error(`[ClawTell] Failed to get signed URL for file ${safeFileId}: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json() as any;
    const signedUrl = data.signedUrl || data.url;
    if (!signedUrl) {
      console.error(`[ClawTell] No signed URL in response for file ${safeFileId}`);
      return null;
    }

    // Step 2: Download file to temp directory with size limit
    const tmpDir = path.join(os.tmpdir(), "clawtell-attachments");
    await fs.mkdir(tmpDir, { recursive: true });
    const safeName = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
    const localPath = path.join(tmpDir, `${safeFileId}_${safeName}`);

    const dlResp = await fetch(signedUrl, { signal: AbortSignal.timeout(60000) });
    if (!dlResp.ok || !dlResp.body) {
      console.error(`[ClawTell] Failed to download file from signed URL: HTTP ${dlResp.status}`);
      return null;
    }

    // Check content-length before downloading
    const contentLength = parseInt(dlResp.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_ATTACHMENT_BYTES) {
      console.error(`[ClawTell] Attachment too large: ${contentLength} bytes (max ${MAX_ATTACHMENT_BYTES})`);
      return null;
    }

    const buffer = Buffer.from(await dlResp.arrayBuffer());
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      console.error(`[ClawTell] Attachment too large after download: ${buffer.length} bytes`);
      return null;
    }
    await fs.writeFile(localPath, buffer);

    // signedUrl is NOT stored — it's ephemeral and must not leak
    console.log(`[ClawTell] Downloaded attachment: ${safeName} (${buffer.length} bytes)`);
    return { filename: attachment.filename, mime_type: attachment.mime_type, localPath };
  } catch (err) {
    console.error(`[ClawTell] Error resolving attachment ${safeFileId}:`, err);
    return null;
  }
}

/**
 * Send attachments to a Telegram chat via Bot API.
 */
async function sendAttachmentsToTelegram(
  botToken: string,
  chatId: string,
  attachments: ResolvedAttachment[],
  caption?: string
): Promise<void> {
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const fileBuffer = await fs.readFile(att.localPath);
    const formData = new FormData();
    formData.append("chat_id", chatId);

    // Only add caption to the first attachment
    if (i === 0 && caption) {
      formData.append("caption", caption);
    }

    const blob = new Blob([fileBuffer], { type: att.mime_type });
    const isImage = att.mime_type.startsWith("image/");
    const endpoint = isImage ? "sendPhoto" : "sendDocument";
    const fieldName = isImage ? "photo" : "document";
    formData.append(fieldName, blob, att.filename);

    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(30000),
    });
    const result = await resp.json() as any;
    if (!result.ok) {
      console.error(`[ClawTell] Telegram ${endpoint} failed:`, result.description);
    } else {
      console.log(`[ClawTell] Telegram ${endpoint} OK: ${att.filename} (${fileBuffer.length} bytes) sent to ${chatId}`);
    }
  }
}

/**
 * Clean up downloaded attachment files.
 */
async function cleanupAttachments(attachments: ResolvedAttachment[]): Promise<void> {
  for (const att of attachments) {
    try { await fs.unlink(att.localPath); } catch { /* ignore */ }
  }
}

/**
 * Resolve all attachments for a message, returning resolved ones and attachment text for agent dispatch.
 */
async function processAttachments(
  apiKey: string,
  rawAttachments: ClawTellAttachment[] | undefined
): Promise<{ resolved: ResolvedAttachment[]; textSuffix: string }> {
  console.log(`[ClawTell] processAttachments: ${rawAttachments?.length ?? 0} raw attachments`);
  if (!rawAttachments || rawAttachments.length === 0) {
    return { resolved: [], textSuffix: "" };
  }

  const resolved: ResolvedAttachment[] = [];
  for (const att of rawAttachments) {
    if (!att.fileId) continue;
    const r = await resolveAttachment(apiKey, att);
    if (r) resolved.push(r);
  }

  if (resolved.length === 0) {
    return { resolved: [], textSuffix: "" };
  }

  // Build text suffix for agent dispatch (include local paths so agent can access files)
  const lines = resolved.map(r => `📎 ${r.filename} (${r.mime_type}) → ${r.localPath}`);
  const textSuffix = `\n\n**Attachments:**\n${lines.join("\n")}`;
  return { resolved, textSuffix };
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
 * Read delivery context from sessions.json for a given agent.
 * Falls back to scanning all sessions for a Telegram delivery context,
 * and finally checks bindings config for a bound Telegram account.
 */
async function getDeliveryContext(agentName: string = "main", config?: ClawdbotConfig): Promise<DeliveryContext | null> {
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
    
    // Primary: use main session's delivery context if it has a real channel address
    // (skip ClawTell addresses like tell/... which aren't valid for forwarding)
    if (dc?.channel && dc?.to && !dc.to.startsWith("tell/")) {
      return {
        channel: dc.channel,
        to: dc.to,
        accountId: dc.accountId || "default"
      };
    }

    // Fallback 1: scan all sessions for a Telegram delivery context
    // (the agent may have Telegram DM sessions under different keys)
    let bestTelegramDc: DeliveryContext | null = null;
    let bestUpdatedAt = 0;
    for (const [key, session] of Object.entries(data)) {
      const sess = session as any;
      const sessDc = sess?.deliveryContext;
      if (sessDc?.channel === "telegram" && sessDc?.to && !sessDc.to.startsWith("tell/")) {
        const updatedAt = sess?.updatedAt || 0;
        if (updatedAt > bestUpdatedAt) {
          bestUpdatedAt = updatedAt;
          bestTelegramDc = {
            channel: "telegram",
            to: sessDc.to,
            accountId: sessDc.accountId || "default"
          };
        }
      }
    }
    if (bestTelegramDc) return bestTelegramDc;

    // Fallback 2: check bindings config for a bound Telegram account
    if (config) {
      const bindings = (config as any).bindings;
      if (Array.isArray(bindings)) {
        for (const binding of bindings) {
          if (binding?.agentId === agentName && binding?.match?.channel === "telegram") {
            const boundAccountId = binding.match.accountId || "default";
            // We have a bound Telegram account but no chat ID — can't forward without a recipient
            console.log(`[ClawTell] Agent ${agentName} has bound Telegram account "${boundAccountId}" but no known chat ID`);
            break;
          }
        }
      }
    }

    // Fallback 3: use explicit forwardTo config (per-route, then global)
    if (config) {
      const clawtellConfig = (config.channels as any)?.clawtell;
      
      // Per-route: check all routing entries for this agent
      if (clawtellConfig?.routing) {
        for (const [name, entry] of Object.entries(clawtellConfig.routing)) {
          const routeEntry = entry as any;
          if (routeEntry?.agent === agentName && routeEntry?.forwardTo?.chatId) {
            const ft = routeEntry.forwardTo;
            console.log(`[ClawTell] Using per-route forwardTo for ${name}: ${ft.channel}:${ft.chatId} (account=${ft.accountId})`);
            return {
              channel: ft.channel || "telegram",
              to: `${ft.channel || "telegram"}:${ft.chatId}`,
              accountId: ft.accountId || "default"
            };
          }
        }
      }
      
      // Global fallback
      const forwardTo = clawtellConfig?.forwardTo;
      if (forwardTo?.channel && forwardTo?.chatId) {
        console.log(`[ClawTell] Using global forwardTo config: ${forwardTo.channel}:${forwardTo.chatId}`);
        return {
          channel: forwardTo.channel,
          to: `${forwardTo.channel}:${forwardTo.chatId}`,
          accountId: forwardTo.accountId || "default"
        };
      }
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
  agentName: string = "main",
  attachments: ResolvedAttachment[] = []
): Promise<void> {
  const dc = await getDeliveryContext(agentName, config);
  
  if (!dc) {
    console.log(`[ClawTell] No active delivery context for agent=${agentName}, skipping forward`);
    return;
  }
  
  console.log(`[ClawTell] Forwarding to ${dc.channel}: ${dc.to} (agent=${agentName})`);
  const sendOpts = { accountId: dc.accountId || "default" };
  
  try {
    switch (dc.channel) {
      case "telegram":
        // Always use direct Telegram API for forwarding — runtime.sendMessageTelegram
        // may not respect accountId correctly for cross-agent forwarding
        {
          const telegramConfig = (config.channels as any)?.telegram;
          const account = telegramConfig?.accounts?.[dc.accountId || "default"] || telegramConfig;
          const botToken = account?.botToken;
          console.log(`[ClawTell] Telegram forward: accountId=${dc.accountId}, hasToken=${!!botToken}, to=${dc.to}`);
          if (botToken) {
            const chatId = dc.to.replace(/^telegram:/, "");
            // Try with Markdown first, fall back to plain text if parsing fails
            let resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: messageContent, parse_mode: "Markdown" }),
              signal: AbortSignal.timeout(10000),
            });
            let result = await resp.json();
            if (!result.ok && result.description?.includes("can't parse entities")) {
              // Retry without parse_mode (plain text)
              console.log("[ClawTell] Markdown parse failed, retrying as plain text");
              resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text: messageContent }),
                signal: AbortSignal.timeout(10000),
              });
              result = await resp.json();
            }
            if (!result.ok) console.error("[ClawTell] Telegram API error:", result.description);
            // Send attachments if any
            console.log(`[ClawTell] Attachment check: ${attachments.length} resolved attachments`);
            if (attachments.length > 0) {
              console.log(`[ClawTell] Sending ${attachments.length} attachments to Telegram chatId=${chatId}`);
              await sendAttachmentsToTelegram(botToken, chatId, attachments);
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
  
  // Ultimate fallback: main agent, forward (uses account-level key)
  return { agent: "main", forward: true };
}

/**
 * Resolve the API key for a route entry. Per-route apiKey overrides account-level key.
 */
function resolveReplyKey(route: ClawTellRouteEntry, accountApiKey: string): string {
  return route.apiKey || accountApiKey;
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
  apiKey: string,        // account-level key (for polling/ACK)
  replyApiKey: string,   // per-route key (for sending replies back)
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
          console.log(`[ClawTell] Sending reply from ${params.toName} to ${params.senderName} (key=${replyApiKey === apiKey ? 'account' : 'route-specific'})`);
          await fetch(`${CLAWTELL_API_BASE}/messages/send`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${replyApiKey}`,
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
        
        const ok = await dispatchToAgent(runtime, opts, qm.apiKey, qm.replyApiKey || qm.apiKey, {
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
        
        console.log(`[ClawTell] Message ${msg.id}: ${senderName} → ${toName} → agent:${agentName} (forward:${route.forward}) ATTS=${msg.attachments?.length ?? 0}`);
        
        // Process attachments
        const { resolved: resolvedAttachments, textSuffix: attachmentSuffix } = await processAttachments(apiKey, msg.attachments);
        
        // Format message
        const messageContent = msg.subject
          ? `🦞🦞 *ClawTell Delivery* 🦞🦞\n\nfrom *tell/${senderName}*\nto: *${toName}*\n\n*Subject:* ${msg.subject}\n\n${msg.body}`
          : `🦞🦞 *ClawTell Delivery* 🦞🦞\n\nfrom *tell/${senderName}*\nto: *${toName}*\n\n${msg.body}`;
        
        // Message content for agent includes attachment paths
        const agentMessageContent = messageContent + attachmentSuffix;
        
        // Forward to human's active channel if configured
        if (route.forward) {
          try {
            await forwardToActiveChannel(runtime, messageContent, opts.config, agentName, resolvedAttachments);
          } catch (err) {
            console.error("[ClawTell] Forward failed:", err);
          }
        }
        
        // Dispatch to agent session (use per-route apiKey for replies)
        const replyKey = resolveReplyKey(route, apiKey);
        const ok = await dispatchToAgent(runtime, opts, apiKey, replyKey, {
          msgId: msg.id,
          senderName,
          toName,
          agentName,
          messageContent: agentMessageContent,
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
            replyApiKey: replyKey !== apiKey ? replyKey : undefined,
            replyToMessageId: msg.replyToMessageId,
          });
          // ACK on server — we own delivery now via local queue
          ackedIds.push(msg.id);
        }
        // If main agent dispatch fails, don't ACK — server will retry next poll
        
        // Clean up temp files (after dispatch, agent has had chance to read them)
        if (resolvedAttachments.length > 0) {
          // Delay cleanup slightly so agent session can read files
          setTimeout(() => cleanupAttachments(resolvedAttachments), 60000);
        }
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
        
        // Process attachments
        const { resolved: resolvedAttachments, textSuffix: attachmentSuffix } = await processAttachments(apiKey, msg.attachments);
        
        const messageContent = msg.subject
          ? `🦞🦞 ClawTell Delivery 🦞🦞\nfrom tell/${senderName}\n**Subject:** ${msg.subject}\n\n${msg.body}`
          : `🦞🦞 ClawTell Delivery 🦞🦞\nfrom tell/${senderName}\n\n${msg.body}`;
        
        const agentMessageContent = messageContent + attachmentSuffix;
        
        try {
          await forwardToActiveChannel(runtime, messageContent, opts.config, "main", resolvedAttachments);
        } catch (err) {
          console.error("[ClawTell] Forward failed:", err);
        }
        
        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
          Body: agentMessageContent,
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
              await fetch(`${CLAWTELL_API_BASE}/messages/send`, {
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
        if (resolvedAttachments.length > 0) {
          setTimeout(() => cleanupAttachments(resolvedAttachments), 60000);
        }
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
