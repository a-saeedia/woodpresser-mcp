/**
 * Tool execution context and shared wrappers.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WpClient } from '../wp/client.js';
import type { SiteConfig } from '../wp/types.js';
import { WpError } from '../wp/types.js';
import { errorResult, jsonResult } from '../util/result.js';
import { recordAudit } from '../util/audit.js';

export interface ToolContext {
  siteName: string;
  site: SiteConfig;
  client: WpClient;
}

export function createContext(siteName: string, site: SiteConfig): ToolContext {
  return { siteName, site, client: new WpClient(site) };
}

export function hasMode(ctx: ToolContext, mode: 'core' | 'php' | 'elementor'): boolean {
  // normalizeSite always fills modes; the fallback must stay the safe one.
  return (ctx.site.modes ?? ['core']).includes(mode);
}

function describe(error: unknown): { message: string; extra: Record<string, unknown> } {
  if (error instanceof WpError) {
    return {
      message: error.message,
      extra: {
        status: error.status,
        code: error.code,
        hint: error.hint,
      },
    };
  }
  const err = error as Error;
  return { message: err?.message ?? String(error), extra: {} };
}

/** Run a tool body with uniform error handling + optional audit entry. */
export async function runTool(
  ctx: ToolContext,
  tool: string,
  fn: () => Promise<CallToolResult> | CallToolResult,
  audit?: { action: string; target?: string; detail?: unknown },
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const result = await fn();
    if (audit) {
      recordAudit({
        site: ctx.siteName,
        tool,
        action: audit.action,
        target: audit.target,
        detail: audit.detail,
        ok: !result.isError,
        durationMs: Date.now() - started,
      });
    }
    return result;
  } catch (error) {
    const { message, extra } = describe(error);
    recordAudit({
      site: ctx.siteName,
      tool,
      action: audit?.action ?? 'error',
      target: audit?.target,
      ok: false,
      detail: message,
      durationMs: Date.now() - started,
    });
    return errorResult(message, { tool, ...extra });
  }
}

/** Uniform success envelope. */
export function ok(payload: Record<string, unknown>, maxBytes?: number): CallToolResult {
  return jsonResult({ ok: true, ...payload }, maxBytes);
}

/** Guard destructive operations behind an explicit literal. */
export function requireConfirm(value: string | undefined, expected: string, action: string): void {
  if (value !== expected) {
    throw new Error(
      `Refusing to ${action}. Pass confirm:"${expected}" to proceed. This guard exists because the operation is destructive or irreversible.`,
    );
  }
}

/** Pick only defined keys. */
export function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as Partial<T>;
}

/** Fail fast when a bridge-only tool is used without a bridge token. */
export function requireBridge(ctx: ToolContext): void {
  if (!ctx.site.bridgeToken) {
    throw new Error(
      'This site has no bridge token. Run `woodpresser init` (or `woodpresser bridge claim`) to install and claim the bridge plugin; PHP, DB, filesystem, snippet and Elementor tools need it.',
    );
  }
}