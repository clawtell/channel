/**
 * ClawTell health probe
 */

const CLAWTELL_API_BASE = "https://clawtell.com/api";

export interface ClawTellProbe {
  ok: boolean;
  name?: string;
  error?: string;
  latencyMs?: number;
}

export interface ProbeClawTellOptions {
  apiKey: string | null;
  timeoutMs?: number;
}

export async function probeClawTell(
  opts: ProbeClawTellOptions
): Promise<ClawTellProbe> {
  const { apiKey, timeoutMs = 10000 } = opts;
  
  if (!apiKey) {
    return { ok: false, error: "No API key configured" };
  }
  
  const start = Date.now();
  
  try {
    const response = await fetch(`${CLAWTELL_API_BASE}/me`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    
    const latencyMs = Date.now() - start;
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        ok: false,
        error: errorData.error || `HTTP ${response.status}`,
        latencyMs,
      };
    }
    
    const data = await response.json();
    
    return {
      ok: true,
      name: data.name,
      latencyMs,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - start,
    };
  }
}
