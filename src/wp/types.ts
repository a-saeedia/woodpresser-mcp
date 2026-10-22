/**
 * Shared types.
 */

export type Mode = 'core' | 'php' | 'elementor';

export interface SiteConfig {
  /** Full base URL, e.g. https://example.com or https://example.com/blog */
  url: string;
  /** WordPress username. */
  username: string;
  /** Application password (spaces are stripped). */
  appPassword: string;
  /** Shared secret configured in the bridge plugin. */
  bridgeToken?: string;
  /** Enabled tool groups. */
  modes?: Mode[];
  /** Human label. */
  label?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

export interface ConfigFile {
  version: 1;
  defaultSite?: string;
  sites: Record<string, SiteConfig>;
}

export interface WpErrorBody {
  code?: string;
  message?: string;
  data?: { status?: number; [key: string]: unknown };
}

export class WpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly url: string;
  readonly body: unknown;

  constructor(message: string, status: number, code: string, url: string, body?: unknown) {
    super(message);
    this.name = 'WpError';
    this.status = status;
    this.code = code;
    this.url = url;
    this.body = body;
  }

  /** Actionable hint for common WordPress failures. */
  get hint(): string {
    // Code first: WordPress codes are specific, statuses are not.
    if (this.code === 'woodpresser_bad_token') {
      return 'Bridge token mismatch. Re-bind both sides: woodpresser bridge claim';
    }
    if (this.code === 'woodpresser_not_claimed') {
      return 'Bridge is installed but not claimed. Run: woodpresser bridge claim';
    }
    if (this.code === 'woodpresser_already_claimed') {
      return 'Another machine claimed this bridge. Copy its token (woodpresser sites there) and run: woodpresser init --token <token>';
    }
    if (this.code === 'woodpresser_token_locked') {
      return 'WOODPRESSER_TOKEN is defined in wp-config.php, so the token cannot change over HTTP. Put the same value in the client config.';
    }
    if (this.code === 'application_passwords_disabled' || this.code === 'app_passwords_disabled') {
      return 'Application Passwords are disabled on this site (often by a security plugin). Enable them, or define WOODPRESSER_TOKEN and use the bridge directly.';
    }
    if (this.code === 'rest_no_route') {
      return 'That REST route does not exist. For bridge routes: the plugin is inactive, or it was unzipped into a nested folder (needs wp-content/plugins/woodpresser-bridge/).';
    }
    if (this.code === 'rest_cannot_edit' || this.code === 'rest_forbidden') {
      return 'The account lacks the capability for this action. Use an administrator, or a role that can edit the post type.';
    }
    if (this.status === 401) return 'Application Password rejected. Confirm the user exists and the password was copied in full (spaces allowed).';
    if (this.status === 403) return 'Authenticated but not allowed. The user needs the administrator role, and the bridge token must match.';
    if (this.status === 404) return 'Route not found. The bridge plugin may be inactive, or the site URL includes a subdirectory you did not include.';
    if (this.status === 428) return 'Bridge is installed but not claimed. Run: woodpresser bridge claim';
    if (this.status === 429) return 'Rate limited by the site or the bridge (240 req/min). Retry after a short pause.';
    if (this.status >= 500) return 'Server-side failure. Check the host error log; LiteSpeed worker saturation is a common cause on shared hosting.';
    if (this.status === 0) return 'No response. Check the site URL, DNS and that the site is reachable from this machine.';
    return '';
  }
}
