/**
 * ClawTell channel plugin implementation
 * 
 * Provides agent-to-agent messaging via the ClawTell network.
 * Uses polling for message delivery (simple, works behind NAT/firewalls).
 */

import type { 
  ChannelPlugin, 
  ClawdbotConfig,
  ChannelAccountSnapshot,
} from "clawdbot/plugin-sdk";
import { 
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "clawdbot/plugin-sdk";

import { sendClawTellMessage, sendClawTellMediaMessage, type ClawTellSendResult } from "./send.js";
import { probeClawTell, type ClawTellProbe } from "./probe.js";
import { pollClawTellInbox } from "./poll.js";

// Channel metadata
const meta = {
  id: "clawtell",
  label: "ClawTell",
  selectionLabel: "ClawTell (Agent-to-Agent)",
  detailLabel: "ClawTell",
  docsPath: "/channels/clawtell",
  docsLabel: "clawtell",
  blurb: "Agent-to-agent messaging via ClawTell network.",
  systemImage: "bubble.left.and.bubble.right",
  aliases: ["ct", "tell"],
  order: 80,
};

// Resolved account configuration
export interface ResolvedClawTellAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  apiKey: string | null;
  tellName: string | null;
  pollIntervalMs: number;
  pollAccount: boolean;
  routing: ClawTellRouting;
  config: {
    name?: string;
    apiKey?: string;
    pollIntervalMs?: number;
    pollAccount?: boolean;
    routing?: ClawTellRouting;
  };
}

// Routing config for multi-name accounts
export interface ClawTellRouteEntry {
  agent: string;
  forward: boolean;
}

export type ClawTellRouting = Record<string, ClawTellRouteEntry>;

// Config schema
interface ClawTellChannelConfig {
  enabled?: boolean;
  name?: string;
  apiKey?: string;
  pollIntervalMs?: number;
  pollAccount?: boolean;
  routing?: ClawTellRouting;
  accounts?: Record<string, {
    enabled?: boolean;
    name?: string;
    apiKey?: string;
    pollIntervalMs?: number;
    pollAccount?: boolean;
    routing?: ClawTellRouting;
  }>;
}

function getChannelConfig(cfg: ClawdbotConfig): ClawTellChannelConfig | undefined {
  return cfg.channels?.clawtell as ClawTellChannelConfig | undefined;
}

function resolveClawTellAccount(opts: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): ResolvedClawTellAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = opts;
  const channelConfig = getChannelConfig(cfg);
  
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  const accountConfig = isDefault 
    ? channelConfig 
    : channelConfig?.accounts?.[accountId];
  
  const enabled = accountConfig?.enabled ?? (isDefault && channelConfig?.enabled) ?? false;
  const tellName = accountConfig?.name ?? null;
  const apiKey = accountConfig?.apiKey ?? null;
  const configured = Boolean(tellName && apiKey);
  
  // Resolve routing config with backward compat
  const rawRouting = (accountConfig as any)?.routing as ClawTellRouting | undefined;
  const pollAccount = (accountConfig as any)?.pollAccount ?? !!rawRouting;
  
  let routing: ClawTellRouting;
  if (rawRouting) {
    // Ensure forward defaults to true for all entries
    routing = {};
    for (const [name, entry] of Object.entries(rawRouting)) {
      routing[name] = { agent: entry.agent ?? "main", forward: entry.forward ?? true };
    }
  } else if (tellName && !pollAccount) {
    // Backward compat: auto-generate single-name routing
    routing = { [tellName]: { agent: "main", forward: true } };
  } else {
    routing = {};
  }
  
  return {
    accountId,
    name: tellName ?? accountId,
    enabled,
    configured,
    apiKey,
    tellName,
    pollIntervalMs: accountConfig?.pollIntervalMs ?? 30000,
    pollAccount,
    routing,
    config: accountConfig ?? {},
  };
}

function listClawTellAccountIds(cfg: ClawdbotConfig): string[] {
  const channelConfig = getChannelConfig(cfg);
  if (!channelConfig) return [];
  
  const ids: string[] = [];
  
  // Check if base config has credentials (default account)
  if (channelConfig.name && channelConfig.apiKey) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }
  
  // Check named accounts
  if (channelConfig.accounts) {
    for (const id of Object.keys(channelConfig.accounts)) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  
  return ids;
}

export const clawtellPlugin: ChannelPlugin<ResolvedClawTellAccount> = {
  id: "clawtell",
  meta,
  capabilities: {
    chatTypes: ["direct"],
    media: true,  // Media sent as attachment links in message body
    reactions: false,
    edit: false,
    unsend: false,
    reply: true,
    effects: false,
    groupManagement: false,
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
      hasRepliedRef,
    }),
  },
  agentPrompt: {
    messageToolHints: ({ cfg }: { cfg: any; accountId?: string }) => {
      const clawtellConfig = cfg?.channels?.clawtell;
      if (!clawtellConfig?.enabled) return [];
      const tellName = clawtellConfig?.name || '';
      return [
        '',
        '### ClawTell Sending',
        'When the user says **"tell/<name> <message>"** or **"tell <name> <message>"** (e.g. "tell/alice Hey, meeting at 3pm"):',
        '1. Extract the **recipient name** (the part after `tell/` or `tell `)',
        '2. Compose the message naturally from the user\'s intent (write as the agent speaking, don\'t just copy-paste) — unless the user says "send exactly this", in which case send verbatim',
        '3. Send via `exec`:',
        '```',
        'curl -s -X POST "https://www.clawtell.com/api/messages/send" \\',
        '  -H "Authorization: Bearer <your-clawtell-api-key>" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d \'{"to":"<recipient_name>","subject":"<brief topic>","body":"<composed message>"}\'',
        '```',
        `- **API key**: Use the ClawTell key from your config (channels.clawtell.apiKey)${tellName ? ` — your ClawTell name is \`${tellName}\`` : ''}`,
        '- **After sending**, confirm: ✅ Message sent to tell/<name>',
        '- **If it fails**, show the error and troubleshoot.',
      ];
    },
  },
  reload: { configPrefixes: ["channels.clawtell"] },
  config: {
    listAccountIds: (cfg) => listClawTellAccountIds(cfg as ClawdbotConfig),
    resolveAccount: (cfg, accountId) =>
      resolveClawTellAccount({ cfg: cfg as ClawdbotConfig, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const next = { ...cfg } as ClawdbotConfig;
      if (!next.channels) next.channels = {};
      if (!next.channels.clawtell) next.channels.clawtell = {};
      
      if (accountId === DEFAULT_ACCOUNT_ID) {
        (next.channels.clawtell as ClawTellChannelConfig).enabled = enabled;
      } else {
        const channelConfig = next.channels.clawtell as ClawTellChannelConfig;
        if (!channelConfig.accounts) channelConfig.accounts = {};
        if (!channelConfig.accounts[accountId]) channelConfig.accounts[accountId] = {};
        channelConfig.accounts[accountId].enabled = enabled;
      }
      return next;
    },
    deleteAccount: ({ cfg, accountId }) => {
      const next = { ...cfg } as ClawdbotConfig;
      const channelConfig = next.channels?.clawtell as ClawTellChannelConfig | undefined;
      if (!channelConfig) return next;
      
      if (accountId === DEFAULT_ACCOUNT_ID) {
        delete channelConfig.name;
        delete channelConfig.apiKey;
        delete channelConfig.enabled;
      } else if (channelConfig.accounts) {
        delete channelConfig.accounts[accountId];
      }
      return next;
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: () => [],
    formatAllowFrom: ({ allowFrom }) => allowFrom,
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: "open" as const,  // ClawTell handles allowlists server-side
      allowFrom: [],
      policyPath: "channels.clawtell.dmPolicy",
      allowFromPath: "channels.clawtell.",
      approveHint: "ClawTell handles allowlists via the web dashboard",
      normalizeEntry: (raw) => raw.toLowerCase().replace(/^tell\//, ""),
    }),
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target?.trim().toLowerCase();
      if (!trimmed) return null;
      // Strip tell/ prefix if present
      return trimmed.replace(/^tell\//, "");
    },
    targetResolver: {
      looksLikeId: (value) => /^[a-z0-9-]+$/.test(value.replace(/^tell\//, "")),
      hint: "<tell/name or name>",
    },
    formatTargetDisplay: ({ target }) => {
      const name = target?.replace(/^tell\//, "").trim();
      return name ? `tell/${name}` : target ?? "";
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => {
      const next = { ...cfg } as ClawdbotConfig;
      if (!next.channels) next.channels = {};
      if (!next.channels.clawtell) next.channels.clawtell = {};
      
      if (accountId === DEFAULT_ACCOUNT_ID) {
        (next.channels.clawtell as ClawTellChannelConfig).name = name;
      } else {
        const channelConfig = next.channels.clawtell as ClawTellChannelConfig;
        if (!channelConfig.accounts) channelConfig.accounts = {};
        if (!channelConfig.accounts[accountId]) channelConfig.accounts[accountId] = {};
        channelConfig.accounts[accountId].name = name;
      }
      return next;
    },
    validateInput: ({ input }) => {
      if (!input.name && !input.apiKey) {
        return "ClawTell requires --name and --api-key.";
      }
      if (!input.name) return "ClawTell requires --name (your tell/ name).";
      if (!input.apiKey) return "ClawTell requires --api-key.";
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const next = { ...cfg } as ClawdbotConfig;
      if (!next.channels) next.channels = {};
      if (!next.channels.clawtell) next.channels.clawtell = {};
      
      const channelConfig = next.channels.clawtell as ClawTellChannelConfig;
      
      if (accountId === DEFAULT_ACCOUNT_ID) {
        channelConfig.enabled = true;
        if (input.name) channelConfig.name = input.name.replace(/^tell\//, "");
        if (input.apiKey) channelConfig.apiKey = input.apiKey;
      } else {
        if (!channelConfig.accounts) channelConfig.accounts = {};
        if (!channelConfig.accounts[accountId]) channelConfig.accounts[accountId] = {};
        const accountCfg = channelConfig.accounts[accountId];
        accountCfg.enabled = true;
        if (input.name) accountCfg.name = input.name.replace(/^tell\//, "");
        if (input.apiKey) accountCfg.apiKey = input.apiKey;
      }
      
      return next;
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 50000,  // ClawTell allows up to 50KB messages
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to ClawTell requires --to <tell/name or name>"),
        };
      }
      // Normalize: strip tell/ prefix
      const name = trimmed.toLowerCase().replace(/^tell\//, "");
      return { ok: true, to: name };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const account = resolveClawTellAccount({ 
        cfg: cfg as ClawdbotConfig, 
        accountId: accountId ?? undefined 
      });
      
      if (!account.apiKey) {
        return { 
          ok: false, 
          error: new Error("ClawTell API key not configured") 
        };
      }
      
      const result = await sendClawTellMessage({
        apiKey: account.apiKey,
        to,
        body: text,
        replyToId: replyToId ?? undefined,
      });
      
      return { channel: "clawtell", ...result };
    },
    sendMedia: async ({ cfg, to, caption, mediaUrl, accountId, replyToId }) => {
      const account = resolveClawTellAccount({ 
        cfg: cfg as ClawdbotConfig, 
        accountId: accountId ?? undefined 
      });
      
      if (!account.apiKey) {
        return { 
          ok: false, 
          error: new Error("ClawTell API key not configured") 
        };
      }
      
      // ClawTell doesn't support native media, so we include the URL in the message
      const result = await sendClawTellMediaMessage({
        apiKey: account.apiKey,
        to,
        body: caption ?? "Media attachment",
        mediaUrl: mediaUrl ?? undefined,
        replyToId: replyToId ?? undefined,
      });
      
      return { channel: "clawtell", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: ({ account }) => {
      const issues: string[] = [];
      if (!account?.configured) {
        issues.push("ClawTell not configured: set channels.clawtell.name and channels.clawtell.apiKey");
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeClawTell({
        apiKey: account.apiKey,
        timeoutMs,
      }),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const running = runtime?.running ?? false;
      const probeOk = (probe as ClawTellProbe | undefined)?.ok;
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        tellName: account.tellName,
        running,
        connected: probeOk ?? running,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const cfg = ctx.cfg as ClawdbotConfig;
      
      ctx.setStatus({
        accountId: account.accountId,
        tellName: account.tellName,
      });
      
      ctx.log?.info(`[${account.accountId}] starting ClawTell (name=${account.tellName}, poll=${account.pollIntervalMs}ms)`);
      
      // Start inbox polling loop
      return pollClawTellInbox({
        account,
        config: cfg,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
