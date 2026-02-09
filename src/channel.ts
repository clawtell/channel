/**
 * ClawTell channel plugin implementation
 * 
 * Provides agent-to-agent messaging via the ClawTell network.
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
import { storeGeneratedSecret } from "./runtime.js";
import { randomBytes } from "crypto";

// ClawTell API base URL
const CLAWTELL_API_BASE = process.env.CLAWTELL_API_URL || "https://www.clawtell.com/api";

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
  webhookPath: string;
  webhookSecret: string | null;
  gatewayUrl: string | null;
  autoRegister: boolean;
  config: {
    name?: string;
    apiKey?: string;
    pollIntervalMs?: number;
    webhookPath?: string;
    webhookSecret?: string;
    gatewayUrl?: string;
    autoRegister?: boolean;
  };
}

// Config schema
interface ClawTellChannelConfig {
  enabled?: boolean;
  name?: string;
  apiKey?: string;
  pollIntervalMs?: number;
  webhookPath?: string;
  webhookSecret?: string;
  gatewayUrl?: string;
  autoRegister?: boolean;  // Default: true - auto-register gateway URL on startup
  accounts?: Record<string, {
    enabled?: boolean;
    name?: string;
    apiKey?: string;
    pollIntervalMs?: number;
    webhookPath?: string;
    webhookSecret?: string;
    gatewayUrl?: string;
    autoRegister?: boolean;
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
  
  const tellName = accountConfig?.name ?? process.env.CLAWTELL_NAME ?? null;
  const apiKey = accountConfig?.apiKey ?? process.env.CLAWTELL_API_KEY ?? null;
  // Only apiKey is required - name can be auto-detected from API
  const configured = Boolean(apiKey);
  // Simple: API key present = enabled, no API key = disabled
  // Config can still explicitly disable if needed (enabled: false)
  const enabled = apiKey ? (accountConfig?.enabled ?? true) : false;
  
  return {
    accountId,
    name: tellName ?? accountId,
    enabled,
    configured,
    apiKey,
    tellName,
    pollIntervalMs: accountConfig?.pollIntervalMs ?? 30000,
    webhookPath: accountConfig?.webhookPath ?? "/webhook/clawtell",
    webhookSecret: accountConfig?.webhookSecret ?? null,
    gatewayUrl: accountConfig?.gatewayUrl ?? null,
    autoRegister: accountConfig?.autoRegister ?? true,  // Default: auto-register
    config: accountConfig ?? {},
  };
}

/**
 * Generate a secure random webhook secret
 */
function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Register gateway URL and webhook secret with ClawTell API
 */
async function registerGatewayWithClawTell(opts: {
  apiKey: string;
  tellName: string;
  gatewayUrl: string;
  webhookSecret: string;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<{ ok: boolean; error?: string }> {
  const { apiKey, tellName, gatewayUrl, webhookSecret, log } = opts;
  
  try {
    const response = await fetch(`${CLAWTELL_API_BASE}/names/${encodeURIComponent(tellName)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        gateway_url: gatewayUrl,
        webhook_secret: webhookSecret,
      }),
      signal: AbortSignal.timeout(15000),
    });
    
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const errMsg = data.error || `HTTP ${response.status}`;
      log?.error(`ClawTell: Failed to register gateway: ${errMsg}`);
      return { ok: false, error: errMsg };
    }
    
    log?.info(`ClawTell: Successfully registered gateway URL: ${gatewayUrl}`);
    return { ok: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    log?.error(`ClawTell: Failed to register gateway: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
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
      if (!account.configured) {
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
      
      // Auto-detect name from API if not configured
      let tellName = account.tellName;
      if (!tellName && account.apiKey) {
        ctx.log?.info(`ClawTell: No name configured, fetching from API...`);
        const probe = await probeClawTell({ apiKey: account.apiKey, timeoutMs: 10000 });
        if (probe.ok && probe.name) {
          tellName = probe.name;
          // Update account object for use in this session
          (account as { tellName: string | null }).tellName = tellName;
          ctx.log?.info(`ClawTell: Auto-detected name: ${tellName}`);
        } else {
          ctx.log?.error(`ClawTell: Failed to detect name from API: ${probe.error}`);
          throw new Error(`ClawTell: Could not determine name from API key. Error: ${probe.error}`);
        }
      }
      
      ctx.setStatus({
        accountId: account.accountId,
        tellName,
      });
      
      ctx.log?.info(`[${account.accountId}] starting ClawTell (name=${tellName}, webhook=${account.webhookPath})`);
      
      // Auto-register gateway URL with ClawTell if enabled
      if (account.autoRegister && account.apiKey && tellName) {
        // Determine gateway URL - from config or auto-detect
        let gatewayUrl = account.gatewayUrl;
        
        if (!gatewayUrl) {
          // Try to get from gateway config
          const gatewayCfg = cfg.gateway as { url?: string; publicUrl?: string } | undefined;
          gatewayUrl = gatewayCfg?.publicUrl || gatewayCfg?.url;
          
          // Fallback: try common environment variables
          if (!gatewayUrl) {
            gatewayUrl = process.env.CLAWDBOT_PUBLIC_URL || 
                         process.env.GATEWAY_URL ||
                         process.env.PUBLIC_URL;
          }
        }
        
        if (gatewayUrl) {
          // Generate webhook secret if not configured
          let webhookSecret = account.webhookSecret;
          if (!webhookSecret) {
            webhookSecret = generateWebhookSecret();
            ctx.log?.info(`ClawTell: Generated new webhook secret (add to config for persistence)`);
            
            // Store the generated secret in runtime for webhook verification
            storeGeneratedSecret(account.accountId, webhookSecret);
          }
          
          // Construct full webhook URL
          const webhookUrl = gatewayUrl.replace(/\/$/, "") + account.webhookPath;
          
          // Register with ClawTell
          const regResult = await registerGatewayWithClawTell({
            apiKey: account.apiKey,
            tellName,
            gatewayUrl: webhookUrl,
            webhookSecret,
            log: ctx.log,
          });
          
          if (!regResult.ok) {
            ctx.log?.warn(`ClawTell: Gateway registration failed, falling back to polling mode`);
          } else {
            ctx.setStatus({ 
              accountId: account.accountId, 
              gatewayRegistered: true,
              webhookUrl,
            });
          }
        } else {
          ctx.log?.warn(`ClawTell: No gateway URL available, using polling mode only. Set channels.clawtell.gatewayUrl or gateway.publicUrl`);
        }
      }
      
      // Start inbox polling loop (works alongside webhooks as fallback)
      return pollClawTellInbox({
        account,
        config: cfg,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
