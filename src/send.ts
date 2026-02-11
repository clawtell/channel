/**
 * ClawTell message sending with retry support
 */

const CLAWTELL_API_BASE = "https://clawtell.com/api";

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;

export interface ClawTellSendResult {
  ok: boolean;
  messageId?: string;
  error?: Error;
  retryCount?: number;
}

export interface SendClawTellMessageOptions {
  apiKey: string;
  to: string;
  body: string;
  subject?: string;
  replyToId?: string;
  fromName?: string;
  maxRetries?: number;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter
 */
function getRetryDelay(attempt: number): number {
  const baseDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * baseDelay; // 0-30% jitter
  return Math.min(baseDelay + jitter, MAX_RETRY_DELAY_MS);
}

/**
 * Check if error is retryable
 */
function isRetryableError(status: number): boolean {
  // Retry on server errors and rate limits
  return status >= 500 || status === 429 || status === 408;
}

/**
 * Send a message via ClawTell with automatic retry
 */
export async function sendClawTellMessage(
  opts: SendClawTellMessageOptions
): Promise<ClawTellSendResult> {
  const { apiKey, to, body, subject, replyToId, fromName, maxRetries = MAX_RETRIES } = opts;
  
  let lastError: Error | undefined;
  let retryCount = 0;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${CLAWTELL_API_BASE}/messages/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          to,
          body,
          subject: subject ?? "Message",
          replyTo: replyToId,
          ...(fromName ? { from_name: fromName } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(errorData.error || `HTTP ${response.status}`);
        
        // Check if we should retry
        if (attempt < maxRetries && isRetryableError(response.status)) {
          lastError = error;
          retryCount = attempt + 1;
          
          // Get retry-after header if present
          const retryAfter = response.headers.get('retry-after');
          const delay = retryAfter 
            ? parseInt(retryAfter, 10) * 1000 
            : getRetryDelay(attempt);
          
          await sleep(delay);
          continue;
        }
        
        return {
          ok: false,
          error,
          retryCount,
        };
      }
      
      const data = await response.json();
      
      return {
        ok: true,
        messageId: data.messageId,
        retryCount,
      };
      
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      
      // Retry on network errors
      if (attempt < maxRetries) {
        retryCount = attempt + 1;
        const delay = getRetryDelay(attempt);
        await sleep(delay);
        continue;
      }
      
      return {
        ok: false,
        error: err,
        retryCount,
      };
    }
  }
  
  // Should not reach here, but handle gracefully
  return {
    ok: false,
    error: lastError ?? new Error("Max retries exceeded"),
    retryCount,
  };
}

/**
 * Send a message with media attachment (placeholder for future)
 */
export async function sendClawTellMediaMessage(
  opts: SendClawTellMessageOptions & { mediaUrl?: string; mediaType?: string }
): Promise<ClawTellSendResult> {
  // TODO: Implement media support when ClawTell API supports it
  // For now, just send the message with a link to the media
  const { mediaUrl, ...messageOpts } = opts;
  
  let body = opts.body;
  if (mediaUrl) {
    body = `${opts.body}\n\n📎 Attachment: ${mediaUrl}`;
  }
  
  return sendClawTellMessage({ ...messageOpts, body });
}
