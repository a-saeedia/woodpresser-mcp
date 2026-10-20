/**
 * PHP-tier tools. These require the Woodpresser Bridge plugin and give the
 * agent execution, database, filesystem and snippet powers that core REST
 * cannot express.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { compact, ok, requireBridge, requireConfirm, runTool, type ToolContext } from './context.js';

const READ_KEYWORDS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH']);

function statementKind(sql: string): string {
  const cleaned = sql.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)+/, '');
  const match = cleaned.match(/^([A-Za-z]+)/);
  return (match?.[1] ?? '').toUpperCase();
}


export function registerPhpTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'wp_bridge_status',
    {
      title: 'Bridge status',
      description:
        'Report the bridge plugin version, environment (WP/PHP/theme/plugins) and the safety flags that gate PHP, shell, DB writes and file writes.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(ctx, 'wp_bridge_status', async () => {
        requireBridge(ctx);
        const ping = await ctx.client.bridge<Record<string, unknown>>('/ping');
        return ok({ bridge: ping });
      }),
  );

  server.registerTool(
    'wp_bridge_flags',
    {
      title: 'Set bridge safety flags',
      description:
        'Toggle server-side capabilities: allow_php, allow_shell, allow_db_write, allow_file_write, allow_plugins. Start read-only and widen only when the task demands it.',
      inputSchema: {
        allow_php: z.boolean().optional(),
        allow_shell: z.boolean().optional(),
        allow_db_write: z.boolean().optional(),
        allow_file_write: z.boolean().optional(),
        allow_plugins: z.boolean().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_bridge_flags',
        async () => {
          requireBridge(ctx);
          const body = compact(args as Record<string, unknown>);
          if (!Object.keys(body).length) throw new Error('Nothing to change.');
          const result = await ctx.client.bridge<Record<string, unknown>>('/flags', {
            method: 'POST',
            body,
          });
          return ok(result);
        },
        { action: 'bridge_flags', detail: args },
      ),
  );

  server.registerTool(
    'wp_php_run',
    {
      title: 'Run PHP on the site',
      description:
        'Execute PHP inside the live WordPress runtime with WordPress loaded ($wpdb, WP_Query, all plugins available). Output buffering and return values are captured; fatal errors are reported. Use it to inspect real state, not to guess. Requires confirm:"run".',
      inputSchema: {
        code: z.string().describe('PHP without the opening <?php tag'),
        mode: z
          .enum(['php', 'template'])
          .default('php')
          .describe('php = pure code; template = mixed code and HTML output'),
        confirm: z.string().describe('Must be "run"'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_php_run',
        async () => {
          requireBridge(ctx);
          requireConfirm(args.confirm, 'run', 'execute PHP on the live site');

          const result = await ctx.client.bridge<Record<string, unknown>>('/php', {
            method: 'POST',
            body: { code: args.code, mode: args.mode },
            timeoutMs: 90_000,
          });

          return ok({ result });
        },
        { action: 'php_run', detail: { bytes: args.code.length } },
      ),
  );

  server.registerTool(
    'wp_db_query',
    {
      title: 'Run SQL',
      description:
        'Run a single SQL statement against the WordPress database. SELECT/SHOW/EXPLAIN are allowed read-only; writes need allow_db_write. Supports %s/%d placeholders through `params`. DROP DATABASE, GRANT, OUTFILE and multi-statements are blocked.',
      inputSchema: {
        sql: z.string(),
        params: z.array(z.union([z.string(), z.number()])).optional(),
        confirm: z.string().optional().describe('Must be "write" for non-read statements'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_db_query',
        async () => {
          requireBridge(ctx);
          const kind = statementKind(args.sql);
          const read = READ_KEYWORDS.has(kind);
          if (!read) requireConfirm(args.confirm, 'write', 'write to the database');

          const result = await ctx.client.bridge<Record<string, unknown>>('/db', {
            method: 'POST',
            body: { sql: args.sql, params: args.params },
          });

          return ok({ kind, read_only: read, result });
        },
        { action: 'db_query', detail: { sql: args.sql.slice(0, 300) } },
      ),
  );

  server.registerTool(
    'wp_fs',
    {
      title: 'Filesystem inside wp-content',
      description:
        'list, read, stat, write, append, mkdir or delete files under wp-content. Writes are jailed, extension-limited, and the previous file is backed up under wp-content/woodpresser-backups.',
      inputSchema: {
        op: z.enum(['list', 'read', 'stat', 'write', 'append', 'mkdir', 'delete']),
        path: z.string().describe('Relative to wp-content, or absolute inside it'),
        content: z.string().optional().describe('Required for write/append'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_fs',
        async () => {
          requireBridge(ctx);
          if ((args.op === 'write' || args.op === 'append') && args.content === undefined) {
            throw new Error('write/append need content.');
          }
          const result = await ctx.client.bridge<Record<string, unknown>>('/fs', {
            method: 'POST',
            body: compact({ op: args.op, path: args.path, content: args.content }),
            timeoutMs: 60_000,
          });
          return ok({ result });
        },
        { action: `fs_${args.op}`, target: args.path },
      ),
  );

  server.registerTool(
    'wp_snippet_list',
    {
      title: 'List managed snippets',
      description:
        'List PHP snippets stored by the bridge. Snippets are versioned PHP blocks with a scope (init, admin_init, wp_head, wp_footer, manual) and an active flag — the safe way to add behaviour without editing theme files.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(ctx, 'wp_snippet_list', async () => {
        requireBridge(ctx);
        const result = await ctx.client.bridge<Record<string, unknown>>('/snippets');
        return ok(result);
      }),
  );

  server.registerTool(
    'wp_snippet_save',
    {
      title: 'Create or update a snippet',
      description:
        'Save a snippet. Omit id to create; pass id to update. Keep active=false, test with wp_snippet_run, then activate.',
      inputSchema: {
        id: z.number().int().optional(),
        name: z.string(),
        code: z.string().describe('PHP without the opening <?php tag'),
        scope: z.enum(['init', 'admin_init', 'wp_head', 'wp_footer', 'manual']).default('manual'),
        active: z.boolean().default(false),
        priority: z.number().int().min(1).max(999).default(10),
        description: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_snippet_save',
        async () => {
          requireBridge(ctx);
          const result = await ctx.client.bridge<Record<string, unknown>>('/snippets/save', {
            method: 'POST',
            body: compact(args as Record<string, unknown>),
            timeoutMs: 60_000,
          });
          return ok(result);
        },
        { action: args.id ? 'snippet_update' : 'snippet_create', target: args.name },
      ),
  );

  server.registerTool(
    'wp_snippet_run',
    {
      title: 'Execute a snippet now',
      description: 'Run one stored snippet immediately and return its output, regardless of active state. Ideal dry-run before activation.',
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_snippet_run',
        async () => {
          requireBridge(ctx);
          const result = await ctx.client.bridge<Record<string, unknown>>('/snippets/run', {
            method: 'POST',
            body: { id: args.id },
            timeoutMs: 90_000,
          });
          return ok({ result });
        },
        { action: 'snippet_run', target: String(args.id) },
      ),
  );

  server.registerTool(
    'wp_snippet_delete',
    {
      title: 'Delete a snippet',
      description: 'Permanently remove a stored snippet. Requires confirm:"delete".',
      inputSchema: {
        id: z.number().int(),
        confirm: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_snippet_delete',
        async () => {
          requireBridge(ctx);
          requireConfirm(args.confirm, 'delete', 'delete a snippet');
          const result = await ctx.client.bridge<Record<string, unknown>>('/snippets/delete', {
            method: 'POST',
            body: { id: args.id },
          });
          return ok(result);
        },
        { action: 'snippet_delete', target: String(args.id) },
      ),
  );

  server.registerTool(
    'wp_post_meta',
    {
      title: 'Read or write post meta',
      description:
        'Direct access to any post meta key, including keys hidden from REST (SEO plugins, page builders, custom fields). Actions: get (all or one key), set, delete.',
      inputSchema: {
        post_id: z.number().int(),
        action: z.enum(['get', 'set', 'delete']).default('get'),
        key: z.string().optional(),
        value: z.unknown().optional(),
        hide_internal: z.boolean().default(true).describe('Hide _-prefixed keys on get'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_post_meta',
        async () => {
          requireBridge(ctx);

          const lines: string[] = ['$post_id = ' + args.post_id + ';'];
          if (args.action === 'get') {
            if (args.key) {
              lines.push(`return [ 'key' => ${JSON.stringify(args.key)}, 'value' => get_post_meta($post_id, ${JSON.stringify(args.key)}, false) ];`);
            } else {
              lines.push(`$all = get_post_meta($post_id);`);
              if (args.hide_internal) {
                lines.push(`foreach (array_keys($all) as $k) { if (0 === strpos($k, '_')) unset($all[$k]); }`);
              }
              lines.push(`return $all;`);
            }
          } else if (args.action === 'set') {
            if (!args.key) throw new Error('set requires key.');
            const encoded = Buffer.from(JSON.stringify(args.value ?? null), 'utf8').toString('base64');
            lines.push(`$value = json_decode(base64_decode('${encoded}'), true);`);
            lines.push(`update_post_meta($post_id, ${JSON.stringify(args.key)}, $value);`);
            lines.push(`return [ 'updated' => true, 'key' => ${JSON.stringify(args.key)} ];`);
          } else {
            if (!args.key) throw new Error('delete requires key.');
            lines.push(`delete_post_meta($post_id, ${JSON.stringify(args.key)});`);
            lines.push(`return [ 'deleted' => true, 'key' => ${JSON.stringify(args.key)} ];`);
          }

          const result = await ctx.client.bridge<Record<string, unknown>>('/php', {
            method: 'POST',
            body: { code: lines.join('\n'), mode: 'php' },
          });

          return ok({ result });
        },
        { action: `meta_${args.action}`, target: `${args.post_id}:${args.key ?? '*'}` },
      ),
  );

  server.registerTool(
    'wp_audit_log',
    {
      title: 'Audit log',
      description: 'Recent mutating calls recorded by the bridge, newest first. Check this when you need to know what an agent already changed.',
      inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(ctx, 'wp_audit_log', async () => {
        requireBridge(ctx);
        const result = await ctx.client.bridge<Record<string, unknown>>('/audit', {
          query: { limit: args.limit },
        });
        return ok(result);
      }),
  );
}
