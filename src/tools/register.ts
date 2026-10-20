/**
 * Tool registration by mode.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { registerCoreTools } from './core.js';
import { registerPhpTools } from './php.js';
import { registerElementorTools } from './elementor.js';

export function registerTools(server: McpServer, ctx: ToolContext): string[] {
  const modes = ctx.site.modes ?? ['core', 'php', 'elementor'];
  const registered: string[] = [];

  if (modes.includes('core')) {
    registerCoreTools(server, ctx);
    registered.push('core');
  }
  if (modes.includes('php')) {
    registerPhpTools(server, ctx);
    registered.push('php');
  }
  if (modes.includes('elementor')) {
    registerElementorTools(server, ctx);
    registered.push('elementor');
  }

  return registered;
}
