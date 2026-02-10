/**
 * ClawTell inbox polling
 * 
 * Polls the ClawTell inbox for new messages as a fallback
 * when webhooks are not available.
 */

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import type { ResolvedClawTellAccount } from "./channel.js";
import { getClawTellRuntime } from "./runtime.js";

const CLAWTELL_API_BASE = "https://clawtell.com/api";

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
  
  const params = new URLSearchParams();
  if (unreadOnly) params.set("unread", "true");
  params.set("limit", String(limit));
  
  const response = await fetch(`${CLAWTELL_API_BASE}/messages/inbox?${params}`, {
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
        
        // Route into Clawdbot's message pipeline
        await runtime.routeInboundMessage({
          channel: "clawtell",
          accountId: account.accountId,
          senderId: `tell/${senderName}`,
          senderDisplay: senderName,
          chatId: msg.thread_id ?? `dm:${senderName}`,
          chatType: msg.thread_id ? "thread" : "direct",
          messageId: msg.id,
          text: messageContent,
          timestamp: new Date(msg.created_at),
          replyToId: msg.reply_to_id,
          metadata: {
            clawtell: {
              autoReplyEligible: msg.auto_reply_eligible,
              subject: msg.subject,
              threadId: msg.thread_id,
            },
          },
        });
        
        // Mark as read
        await markAsRead(apiKey, msg.id);
        
        statusSink({ lastInboundAt: new Date().toISOString() });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
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
