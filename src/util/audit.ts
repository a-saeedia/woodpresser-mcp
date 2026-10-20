/**
 * Local audit trail. Every mutating call appends one JSON line, mirroring the
 * bridge's server-side audit table so both sides can be reconciled.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { redact } from './redact.js';

export interface AuditEntry {
  at: string;
  site: string;
  tool: string;
  action: string;
  target?: string;
  ok: boolean;
  detail?: unknown;
  durationMs?: number;
}

export function auditPath(): string {
  return join(homedir(), '.woodpresser', 'audit.jsonl');
}

export function recordAudit(entry: Omit<AuditEntry, 'at'>): void {
  try {
    const file = auditPath();
    mkdirSync(dirname(file), { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...redact(entry) });
    appendFileSync(file, line + '\n', 'utf8');
  } catch {
    // Auditing must never break a tool call.
  }
}
