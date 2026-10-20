/**
 * Secret redaction. Every outbound payload and error string passes through here
 * so agent transcripts never accumulate credentials.
 */

const SECRET_KEYS = /^(app_?password|password|passwd|secret|token|bridge_?token|api_?key|authorization|cookie|nonce|_wpnonce|auth)$/i;
const BASIC_AUTH = /Basic\s+[A-Za-z0-9+/=]{8,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g;
const APP_PASSWORD = /\b[A-Za-z0-9]{4}(?: [A-Za-z0-9]{4}){5}\b/g;

let knownSecrets: string[] = [];

/** Register concrete secret values to scrub from free text. */
export function registerSecrets(values: Array<string | undefined | null>): void {
  for (const value of values) {
    if (!value) continue;
    const normalized = String(value).replace(/\s+/g, '');
    if (normalized.length >= 8) knownSecrets.push(normalized);
  }
  knownSecrets = [...new Set(knownSecrets)];
}

/** Redact a string. */
export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (secret.length < 8) continue;
    const spaced = secret.match(/.{1,4}/g)?.join(' ') ?? secret;
    out = out.split(secret).join('[redacted]');
    out = out.split(spaced).join('[redacted]');
  }
  return out
    .replace(BASIC_AUTH, 'Basic [redacted]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(APP_PASSWORD, '[redacted-app-password]');
}

/** Recursively redact a value. */
export function redact<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redact(item)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(val);
    }
    return out as T;
  }
  return value;
}
