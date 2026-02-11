/**
 * Local message queue for failed dispatches (Phase 3)
 * 
 * When dispatch to a sub-agent fails, messages are queued locally
 * and retried on subsequent poll cycles. Dead-lettered after MAX_ATTEMPTS.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const QUEUE_DIR = path.join(process.env.HOME || "/home/claw", ".openclaw", "clawtell");
const QUEUE_PATH = path.join(QUEUE_DIR, "inbox-queue.json");
const MAX_ATTEMPTS = 10;

export interface QueuedMessage {
  /** Original ClawTell message ID */
  id: string;
  /** Sender name (without tell/ prefix) */
  from: string;
  /** Target name */
  toName: string;
  /** Resolved agent name */
  agent: string;
  /** Whether to forward to human channel */
  forward: boolean;
  /** Pre-formatted message content */
  content: string;
  /** Raw body for reply context */
  rawBody: string;
  /** Subject line */
  subject?: string;
  /** Original creation time */
  createdAt: string;
  /** When first queued */
  queuedAt: string;
  /** Number of dispatch attempts */
  attempts: number;
  /** Last error message */
  lastError: string;
  /** Account ID for ACK */
  accountId: string;
  /** API key for ACK */
  apiKey: string;
  /** Reply-to message ID */
  replyToMessageId?: string;
}

interface QueueFile {
  pending: QueuedMessage[];
  deadLetter: QueuedMessage[];
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(QUEUE_DIR, { recursive: true });
}

export async function readQueue(): Promise<QueueFile> {
  try {
    const data = await fs.readFile(QUEUE_PATH, "utf8");
    return JSON.parse(data);
  } catch {
    return { pending: [], deadLetter: [] };
  }
}

async function writeQueue(queue: QueueFile): Promise<void> {
  await ensureDir();
  // Write atomically via temp file
  const tmp = QUEUE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(queue, null, 2));
  await fs.rename(tmp, QUEUE_PATH);
}

export async function enqueue(msg: QueuedMessage): Promise<void> {
  const queue = await readQueue();
  // Don't duplicate
  if (queue.pending.some(m => m.id === msg.id)) return;
  queue.pending.push(msg);
  await writeQueue(queue);
  console.log(`[ClawTell Queue] Enqueued msg ${msg.id} for agent:${msg.agent} (attempt ${msg.attempts})`);
}

export async function dequeue(msgId: string): Promise<void> {
  const queue = await readQueue();
  queue.pending = queue.pending.filter(m => m.id !== msgId);
  await writeQueue(queue);
}

export async function markAttempt(msgId: string, error: string): Promise<QueuedMessage | null> {
  const queue = await readQueue();
  const msg = queue.pending.find(m => m.id === msgId);
  if (!msg) return null;
  
  msg.attempts++;
  msg.lastError = error;
  
  if (msg.attempts >= MAX_ATTEMPTS) {
    // Dead letter
    queue.pending = queue.pending.filter(m => m.id !== msgId);
    queue.deadLetter.push(msg);
    // Keep dead letter list bounded
    if (queue.deadLetter.length > 100) {
      queue.deadLetter = queue.deadLetter.slice(-100);
    }
    await writeQueue(queue);
    console.warn(`[ClawTell Queue] DEAD LETTER: msg ${msgId} after ${msg.attempts} attempts: ${error}`);
    return msg;
  }
  
  await writeQueue(queue);
  return null; // not dead-lettered
}

export async function getPending(): Promise<QueuedMessage[]> {
  const queue = await readQueue();
  return queue.pending;
}
