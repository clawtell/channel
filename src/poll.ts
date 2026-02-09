/**
 * ClawTell Long Polling
 * 
 * Uses the /messages/poll endpoint for near-instant message delivery.
 * Messages are acknowledged via /messages/ack after processing.
 */

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import type { ResolvedClawTellAccount } from "./channel.js";
import { getClawTellRuntime } from "./runtime.js";

const CLAWTELL_API_BASE = "https://www.clawtell.com/api";

interface ClawTellMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  createdAt: string;
  replyToMessageId?: string;
  threadId?: string;
  attachments?: Array<{
    url?: string;
    fileId?: string;
    filename?: string;
    mime_type?: string;
  }>;
}

interface PollResponse {
  success: boolean;
  messages: ClawTellMessage[];
}

interface PollOptions {
  account: ResolvedClawTellAccount;
  config: ClawdbotConfig;
  abortSignal: AbortSignal;
  statusSink: (patch: Record<string, unknown>) => void;
}

/**
 * Long poll for new messages
 * Holds connection for up to `timeout` seconds or until messages arrive
 */
async function longPoll(
  apiKey: string,
  opts?: { timeout?: number; limit?: number },
  abortSignal?: AbortSignal
): Promise<ClawTellMessage[]> {
  const { timeout = 30, limit = 50 } = opts ?? {};
  
  const params = new URLSearchParams();
  params.set("timeout", String(timeout));
  params.set("limit", String(limit));
  
  const response = await fetch(`${CLAWTELL_API_BASE}/messages/poll?${params}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
    signal: abortSignal ?? AbortSignal.timeout(35000), // timeout + 5s buffer
  });
  
  if (!response.ok) {
    throw new Error(`Poll failed: HTTP ${response.status}`);
  }
  
  const data: PollResponse = await response.json();
  return data.messages ?? [];
}

/**
 * Acknowledge messages (batch)
 * Marks messages as delivered and schedules for deletion
 */
async function ackMessages(apiKey: string, messageIds: string[]): Promise<void> {
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

export async function pollClawTellInbox(opts: PollOptions): Promise<void> {
  const { account, abortSignal, statusSink } = opts;
  
  if (!account.apiKey) {
    throw new Error("ClawTell API key not configured");
  }
  
  const apiKey = account.apiKey;
  const runtime = getClawTellRuntime();
  
  statusSink({ running: true, lastStartAt: new Date().toISOString() });
  
  while (!abortSignal.aborted) {
    try {
      // Long poll - will return immediately if messages waiting,
      // otherwise holds connection for up to 30 seconds
      const messages = await longPoll(apiKey, { timeout: 30 }, abortSignal);
      
      const processedIds: string[] = [];
      
      for (const msg of messages) {
        const senderName = msg.from.replace(/^tell\//, "");
        
        // Format message content
        const messageContent = msg.subject && msg.subject !== "Message"
          ? `**${msg.subject}**\n\n${msg.body}`
          : msg.body;
        
        // Route into Clawdbot's message pipeline
        await runtime.routeInboundMessage({
          channel: "clawtell",
          accountId: account.accountId,
          senderId: `tell/${senderName}`,
          senderDisplay: senderName,
          chatId: msg.threadId ?? `dm:${senderName}`,
          chatType: msg.threadId ? "thread" : "direct",
          messageId: msg.id,
          text: messageContent,
          timestamp: new Date(msg.createdAt),
          replyToId: msg.replyToMessageId,
          metadata: {
            clawtell: {
              subject: msg.subject,
              threadId: msg.threadId,
              attachments: msg.attachments,
            },
          },
        });
        
        processedIds.push(msg.id);
      }
      
      // Batch acknowledge all processed messages
      if (processedIds.length > 0) {
        await ackMessages(apiKey, processedIds);
        statusSink({ 
          lastInboundAt: new Date().toISOString(),
          messagesProcessed: processedIds.length,
        });
      }
      
    } catch (error) {
      // Ignore abort errors
      if (abortSignal.aborted) break;
      
      const errorMsg = error instanceof Error ? error.message : String(error);
      statusSink({ lastError: errorMsg });
      
      // Brief pause before retry on error
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        abortSignal.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
    }
  }
  
  statusSink({ running: false, lastStopAt: new Date().toISOString() });
}
