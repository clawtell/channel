/**
 * ClawTell inbox polling
 * 
 * Polls the ClawTell inbox for new messages as a fallback
 * when webhooks are not available.
 */

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import type { ResolvedClawTellAccount } from "./channel.js";
import { getClawTellRuntime } from "./runtime.js";

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

async function fetchInbox(
  apiKey: string,
  opts?: { unreadOnly?: boolean; limit?: number }
): Promise<ClawTellMessage[]> {
  const { unreadOnly = true, limit = 50 } = opts ?? {};
  
  console.log("[ClawTell Poll] fetchInbox called - unreadOnly:", unreadOnly, "limit:", limit);
  
  const params = new URLSearchParams();
  if (unreadOnly) params.set("unread", "true");
  params.set("limit", String(limit));
  
  const url = `${CLAWTELL_API_BASE}/messages/inbox?${params}`;
  console.log("[ClawTell Poll] Fetching from URL:", url);
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(30000),
  });
  
  console.log("[ClawTell Poll] Response status:", response.status, response.statusText);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch inbox: HTTP ${response.status}`);
  }
  
  const data = await response.json();
  console.log("[ClawTell Poll] Received", data.messages?.length ?? 0, "messages");
  return data.messages ?? [];
}

async function markAsRead(apiKey: string, messageId: string): Promise<void> {
  console.log("[ClawTell Poll] Marking message as read:", messageId);
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
  
  console.log("[ClawTell Poll] pollClawTellInbox STARTED for account:", account.accountId);
  console.log("[ClawTell Poll] API Key present:", !!account.apiKey);
  console.log("[ClawTell Poll] Poll interval:", account.pollIntervalMs, "ms");
  
  if (!account.apiKey) {
    throw new Error("ClawTell API key not configured");
  }
  
  const pollIntervalMs = account.pollIntervalMs;
  const apiKey = account.apiKey;
  
  console.log("[ClawTell Poll] Getting runtime...");
  const runtime = getClawTellRuntime();
  console.log("[ClawTell Poll] Runtime obtained successfully");
  
  statusSink({ running: true, lastStartAt: new Date().toISOString() });
  
  // Track processed message IDs to avoid duplicates
  const processedIds = new Set<string>();
  
  let pollCount = 0;
  console.log("[ClawTell Poll] Entering polling loop...");
  
  while (!abortSignal.aborted) {
    pollCount++;
    console.log("[ClawTell Poll] === Poll cycle", pollCount, "===");
    
    try {
      console.log("[ClawTell Poll] Fetching inbox...");
      const messages = await fetchInbox(apiKey, { unreadOnly: true });
      console.log("[ClawTell Poll] Fetched", messages.length, "messages");
      
      for (const msg of messages) {
        console.log("[ClawTell Poll] Processing message:", msg.id, "from:", msg.from);
        
        // Skip if already processed
        if (processedIds.has(msg.id)) {
          console.log("[ClawTell Poll] Skipping duplicate message:", msg.id);
          continue;
        }
        processedIds.add(msg.id);
        
        // Cap the set size to prevent memory growth
        if (processedIds.size > 1000) {
          const idsArray = Array.from(processedIds);
          processedIds.clear();
          // Keep the most recent 500
          for (const id of idsArray.slice(-500)) {
            processedIds.add(id);
          }
        }
        
        const senderName = msg.from.replace(/^tell\//, "");
        
        // Format message content
        const messageContent = msg.subject 
          ? `**${msg.subject}**\n\n${msg.body}`
          : msg.body;
        console.log("[ClawTell Poll] Routing message to runtime...");
        
        // Build inbound context using correct Clawdbot API
        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
          Body: messageContent,
          RawBody: msg.body,
          From: `tell/${senderName}`,
          To: `tell/${account.tellName}`,
          SessionKey: `clawtell:${account.accountId}:dm:${senderName}`,
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
        
        console.log("[ClawTell Poll] Context built, dispatching...");
        
        // Dispatch to agent with reply callback
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: inboundCtx,
          cfg: opts.config,
          dispatcherOptions: {
            deliver: async (payload: any) => {
              console.log("[ClawTell Poll] Sending reply back to", senderName);
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
              console.error("[ClawTell Poll] Reply delivery error:", err);
            },
          },
        });
        
        console.log("[ClawTell Poll] Message dispatched successfully");
        // Mark as read
        await markAsRead(apiKey, msg.id);
        
        statusSink({ lastInboundAt: new Date().toISOString() });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("[ClawTell Poll] ERROR in poll cycle:", errorMsg);
      console.error("[ClawTell Poll] Full error:", error);
      statusSink({ lastError: errorMsg });
    }
    
    console.log("[ClawTell Poll] Waiting", pollIntervalMs, "ms before next poll...");
    // Wait for next poll cycle
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, pollIntervalMs);
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  }
  
  console.log("[ClawTell Poll] Polling loop ended (aborted)");
  statusSink({ running: false, lastStopAt: new Date().toISOString() });
}
