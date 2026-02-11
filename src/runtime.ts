/**
 * ClawTell runtime bridge
 * 
 * Provides access to Clawdbot runtime for message routing.
 */

// Extended runtime type that includes channel send methods
export interface ClawTellRuntime {
  channel: {
    reply: {
      finalizeInboundContext: (params: any) => any;
      dispatchReplyWithBufferedBlockDispatcher: (params: any) => Promise<void>;
    };
    telegram?: {
      sendMessageTelegram?: (to: string, text: string, opts?: any) => Promise<void>;
    };
    discord?: {
      sendMessageDiscord?: (to: string, text: string, opts?: any) => Promise<void>;
    };
    slack?: {
      sendMessageSlack?: (to: string, text: string, opts?: any) => Promise<void>;
    };
    signal?: {
      sendMessageSignal?: (to: string, text: string, opts?: any) => Promise<void>;
    };
    whatsapp?: {
      sendMessageWhatsApp?: (to: string, text: string, opts?: any) => Promise<void>;
    };
  };
}

let runtime: ClawTellRuntime | null = null;

export function setClawTellRuntime(r: any): void {
  runtime = r as ClawTellRuntime;
}

export function getClawTellRuntime(): ClawTellRuntime {
  if (!runtime) {
    throw new Error("ClawTell runtime not initialized");
  }
  return runtime;
}
