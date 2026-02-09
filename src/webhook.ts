/**
 * ClawTell webhook handler
 * 
 * Receives messages from the ClawTell delivery system
 * and routes them into the Clawdbot message pipeline.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "crypto";
import { getClawTellRuntime, getGeneratedSecret, getClawTellConfig } from "./runtime.js";

interface ClawTellWebhookPayload {
  event: "message.received";
  messageId: string;
  from: string;       // tell/sender
  to: string;         // tell/recipient
  subject: string;
  body: string;
  autoReplyEligible: boolean;
  timestamp: string;
  replyToMessageId?: string;
  threadId?: string;
}

// Rate limiting: simple in-memory tracker
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // 100 requests per minute per IP

// Webhook path - can be configured
let webhookPath = "/webhook/clawtell";

export function setWebhookPath(path: string): void {
  webhookPath = path.startsWith("/") ? path : `/${path}`;
}

export function getWebhookPath(): string {
  return webhookPath;
}

/**
 * Verify HMAC signature from ClawTell delivery system
 */
function verifySignature(
  signature: string | null,
  body: string,
  secret: string
): boolean {
  if (!signature || !secret) {
    return false;
  }

  // Signature format: sha256=<hex>
  const parts = signature.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") {
    return false;
  }
  const providedHash = parts[1];

  try {
    const expectedHash = createHmac("sha256", secret)
      .update(body, "utf8")
      .digest("hex");

    const providedBuffer = Buffer.from(providedHash, "hex");
    const expectedBuffer = Buffer.from(expectedHash, "hex");

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Simple rate limiting check
 */
function checkRateLimit(clientId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(clientId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(clientId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  entry.count++;
  return true;
}

// Cleanup old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, 60_000);

/**
 * Read request body as string
 */
async function readBody(req: IncomingMessage, maxBytes: number = 1024 * 1024): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        req.destroy();
        resolve({ ok: false, error: "payload too large" });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: true, body });
      } catch {
        resolve({ ok: false, error: "failed to read body" });
      }
    });

    req.on("error", () => {
      resolve({ ok: false, error: "request error" });
    });
  });
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

/**
 * ClawTell webhook handler
 * Matches Clawdbot's expected signature: (req, res) => Promise<boolean>
 */
export async function handleClawTellWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  // Parse URL
  const url = new URL(req.url ?? "/", "http://localhost");
  
  // Only handle our webhook path
  if (url.pathname !== webhookPath) {
    return false;  // Not handled - let other handlers try
  }
  
  // Only accept POST
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }
  
  // Rate limiting
  const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() 
    || (req.headers["x-real-ip"] as string)
    || req.socket?.remoteAddress
    || "unknown";
  
  if (!checkRateLimit(clientIp)) {
    console.warn(`[clawtell] Rate limit exceeded for ${clientIp}`);
    sendJson(res, 429, { error: "Rate limit exceeded" });
    return true;
  }
  
  // Read body
  const bodyResult = await readBody(req);
  if (!bodyResult.ok) {
    sendJson(res, 400, { error: (bodyResult as { ok: false; error: string }).error });
    return true;
  }
  const rawBody = (bodyResult as { ok: true; body: string }).body;
  
  // Get config from runtime
  const config = getClawTellConfig();
  
  // Verify signature if secret is configured
  const webhookSecret = config?.webhookSecret || getGeneratedSecret() || process.env.CLAWTELL_WEBHOOK_SECRET;
  const signature = req.headers["x-clawtell-signature"] as string | undefined;
  
  if (webhookSecret) {
    if (!verifySignature(signature ?? null, rawBody, webhookSecret)) {
      console.warn("[clawtell] Invalid webhook signature");
      sendJson(res, 401, { error: "Invalid signature" });
      return true;
    }
  }
  
  // Parse payload
  let payload: ClawTellWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return true;
  }
  
  // Validate required fields
  if (!payload.messageId || !payload.from || !payload.to || !payload.body) {
    sendJson(res, 400, { error: "Missing required fields" });
    return true;
  }
  
  // Validate recipient
  const myName = config?.name;
  const recipientName = payload.to.replace(/^tell\//, "");
  
  if (myName && recipientName !== myName) {
    console.warn(`[clawtell] Message for ${recipientName}, but we are ${myName}`);
    sendJson(res, 400, { error: "Wrong recipient" });
    return true;
  }
  
  const senderName = payload.from.replace(/^tell\//, "");
  console.log(`[clawtell] Message from ${senderName}: ${payload.subject || "(no subject)"}`);
  
  // Format message content
  const messageContent = payload.subject 
    ? `**${payload.subject}**\n\n${payload.body}`
    : payload.body;
  
  try {
    // Route into Clawdbot's message pipeline
    const runtime = getClawTellRuntime();
    await runtime.routeInboundMessage({
      channel: "clawtell",
      accountId: myName ?? "default",
      senderId: `tell/${senderName}`,
      senderDisplay: senderName,
      chatId: payload.threadId ?? `dm:${senderName}`,
      chatType: payload.threadId ? "thread" : "direct",
      messageId: payload.messageId,
      text: messageContent,
      timestamp: new Date(payload.timestamp),
      replyToId: payload.replyToMessageId,
      metadata: {
        clawtell: {
          autoReplyEligible: payload.autoReplyEligible,
          subject: payload.subject,
          threadId: payload.threadId,
        },
      },
    });
    
    sendJson(res, 200, { received: true, messageId: payload.messageId });
  } catch (error) {
    console.error(`[clawtell] Failed to route message: ${error}`);
    sendJson(res, 500, { error: "Failed to process message" });
  }
  
  return true;
}
