/**
 * MCP response helpers: keep payloads small, structured and always valid JSON.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { redact } from './redact.js';

const DEFAULT_MAX_BYTES = 60_000;

export function jsonResult(payload: unknown, maxBytes = DEFAULT_MAX_BYTES): CallToolResult {
  const safe = redact(payload);
  let text = JSON.stringify(safe, null, 2) ?? 'null';

  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = JSON.stringify(truncateDeep(safe, maxBytes), null, 2);
  }

  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string, extra?: Record<string, unknown>): CallToolResult {
  const body = redact({ ok: false, error: message, ...extra });
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  };
}

/** Shrink large strings and arrays until the payload fits. */
function truncateDeep(value: unknown, budget: number): unknown {
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input == null || typeof input !== 'object') {
      if (typeof input === 'string' && input.length > 4000) {
        return `${input.slice(0, 4000)}…[truncated ${input.length - 4000} chars]`;
      }
      return input;
    }
    if (seen.has(input as object)) return '[circular]';
    seen.add(input as object);

    if (Array.isArray(input)) {
      const limit = depth === 0 ? 100 : 40;
      const sliced = input.slice(0, limit).map((item) => walk(item, depth + 1));
      if (input.length > limit) sliced.push(`…[+${input.length - limit} items]`);
      return sliced;
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      out[key] = walk(val, depth + 1);
    }
    return out;
  };

  let current = walk(value, 0);
  let text = JSON.stringify(current) ?? '';
  let factor = 1;

  while (Buffer.byteLength(text, 'utf8') > budget && factor < 8) {
    factor *= 2;
    current = walk(value, factor);
    text = JSON.stringify(current) ?? '';
  }
  return current;
}
