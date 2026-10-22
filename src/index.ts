/**
 * MCP server bootstrap (stdio).
 *
 * IMPORTANT: stdout is the protocol channel. Diagnostics must go to stderr.
 */
import './boot.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveSite } from './config.js';
import { createContext } from './tools/context.js';
import { registerTools } from './tools/register.js';
import { SERVER_NAME, VERSION } from './version.js';

export interface StartOptions {
  siteName?: string;
}

export async function startServer(options: StartOptions = {}): Promise<void> {
  const { name, site } = resolveSite(options.siteName);
  const ctx = createContext(name, site);

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      instructions: [
        'You have structured access to a WordPress site.',
        'Start with wp_site_info and wp_health_check to learn the environment.',
        'Use wp_content_* for posts/pages, wp_php_run for live inspection, and wp_el_* for Elementor pages.',
        'Elementor tools: read with wp_el_get, author with wp_el_build (dry_run first), adjust with wp_el_patch.',
        'Destructive tools require an explicit confirm literal. Always prefer a snapshot + dry run on a live site.',
      ].join('\n'),
    },
  );

  const modes = registerTools(server, ctx);

  process.on('uncaughtException', (error) => {
    process.stderr.write(`[woodpresser] uncaught: ${error.message}\n`);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[woodpresser] unhandled rejection: ${String(reason)}\n`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[woodpresser] ready site=${name} url=${site.url} modes=${modes.join(',')}\n`,
  );
}
