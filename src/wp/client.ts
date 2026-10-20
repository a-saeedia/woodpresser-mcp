/**
 * WordPress REST client: core (`/wp-json/wp/v2`) plus the bridge namespace.
 */
import { normalizeSite } from '../config.js';
import { WpError } from './types.js';
import type { SiteConfig } from './types.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Send the bridge token header. */
  bridge?: boolean;
  timeoutMs?: number;
  retries?: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  totalPages: number;
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

export class WpClient {
  readonly site: SiteConfig;
  private readonly authHeader: string;

  constructor(site: SiteConfig) {
    this.site = normalizeSite(site);
    const raw = `${this.site.username}:${this.site.appPassword}`;
    this.authHeader = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }

  get base(): string {
    return this.site.url;
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const clean = path.startsWith('/') ? path : `/${path}`;
    const target = new URL(`${this.base}${clean}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      target.searchParams.set(key, String(value));
    }
    return target.toString();
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { items } = await this.requestWithMeta<T>(path, options);
    return items;
  }

  async requestWithMeta<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ items: T; headers: Headers; status: number }> {
    const retries = options.retries ?? 2;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? this.site.timeoutMs ?? 30_000,
      );

      try {
        const headers: Record<string, string> = {
          Authorization: this.authHeader,
          Accept: 'application/json',
          'User-Agent': 'woodpresser-mcp/0.1 (+https://github.com/a-saeedia/woodpresser-mcp)',
        };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
        if (options.bridge) {
          if (!this.site.bridgeToken) {
            throw new WpError(
              'Bridge token is not configured for this site.',
              0,
              'missing_bridge_token',
              path,
            );
          }
          headers['X-Woodpresser-Token'] = this.site.bridgeToken;
        }

        const response = await fetch(this.url(path, options.query), {
          method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
          redirect: 'follow',
        });

        const text = await response.text();
        const parsed = parseBody(text);

        if (!response.ok) {
          if (RETRY_STATUS.has(response.status) && attempt < retries) {
            attempt += 1;
            await sleep(retryDelay(response, attempt));
            continue;
          }
          throw toWpError(response.status, parsed, text, path);
        }

        return { items: parsed as T, headers: response.headers, status: response.status };
      } catch (error) {
        if (error instanceof WpError) throw error;

        const aborted = (error as Error)?.name === 'AbortError';
        if (attempt < retries) {
          attempt += 1;
          await sleep(retryDelay(undefined, attempt));
          continue;
        }
        throw new WpError(
          aborted
            ? `Request timed out after ${options.timeoutMs ?? this.site.timeoutMs ?? 30000}ms.`
            : `Network error: ${(error as Error)?.message ?? String(error)}`,
          0,
          aborted ? 'timeout' : 'network_error',
          path,
        );
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  /** Upload raw bytes to the media library. */
  async uploadBinary(
    buffer: Buffer,
    filename: string,
    mime = 'application/octet-stream',
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.site.timeoutMs ?? 60_000);
    try {
      const response = await fetch(this.url('/wp-json/wp/v2/media'), {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': mime,
          'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
          Accept: 'application/json',
        },
        body: new Uint8Array(buffer),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = parseBody(text);
      if (!response.ok) throw toWpError(response.status, parsed, text, '/wp-json/wp/v2/media');
      return parsed as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }
  /** Core WordPress REST route. */
  async rest<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(`/wp-json/wp/v2${path.startsWith('/') ? path : `/${path}`}`, options);
  }

  /** Bridge plugin route. */
  async bridge<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(
      `/wp-json/woodpresser/v1${path.startsWith('/') ? path : `/${path}`}`,
      { ...options, bridge: true },
    );
  }

  /** Walk every page of a core REST collection. */
  async paginate<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    perPage = 50,
    maxPages = 20,
  ): Promise<Paginated<T>> {
    const collected: T[] = [];
    let total = 0;
    let totalPages = 1;

    for (let page = 1; page <= totalPages && page <= maxPages; page += 1) {
      const { items, headers } = await this.requestWithMeta<T[]>(`/wp-json/wp/v2${path}`, {
        query: { ...query, per_page: perPage, page },
      });
      if (page === 1) {
        total = Number(headers.get('x-wp-total') ?? items.length);
        totalPages = Number(headers.get('x-wp-totalpages') ?? 1);
      }
      collected.push(...(Array.isArray(items) ? items : []));
      if (collected.length >= total) break;
    }

    return { items: collected, total, totalPages };
  }

  /** Bridge ping + feature snapshot. Never throws. */
  async probe(): Promise<{ reachable: boolean; bridge: boolean; data?: Record<string, unknown>; error?: string }> {
    try {
      const ping = await this.bridge<Record<string, unknown>>('/ping');
      return { reachable: true, bridge: true, data: ping };
    } catch (error) {
      const wpError = error as WpError;
      const notInstalled =
        wpError.status === 404 ||
        wpError.code === 'rest_no_route' ||
        wpError.status === 401 ||
        wpError.status === 403;
      if (notInstalled) {
        try {
          const me = await this.rest<Record<string, unknown>>('/users/me', {
            query: { context: 'edit' },
          });
          return {
            reachable: true,
            bridge: false,
            data: { user: me.slug ?? me.name ?? me.id },
            error: 'Bridge plugin not reachable (inactive, not installed, or token mismatch).',
          };
        } catch (inner) {
          return { reachable: true, bridge: false, error: (inner as WpError).message };
        }
      }
      return { reachable: false, bridge: false, error: wpError.message };
    }
  }
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

function toWpError(status: number, parsed: unknown, text: string, path: string): WpError {
  const body = parsed as { code?: string; message?: string; data?: { status?: number } };
  const message =
    body?.message ||
    (typeof text === 'string' && text.startsWith('<')
      ? `HTTP ${status}: the site returned HTML (WAF block, maintenance page, or a wrong base URL).`
      : `HTTP ${status}`);

  return new WpError(message, body?.data?.status ?? status, body?.code ?? `http_${status}`, path, parsed);
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 10_000);
  }
  return 400 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
