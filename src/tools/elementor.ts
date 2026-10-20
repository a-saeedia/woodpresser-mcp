/**
 * Elementor tools. Elementor pages are stored as a JSON tree in post meta, so
 * every operation here is deterministic and reversible (snapshots on write).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  buildElementorData,
  deepMerge,
  ensureIds,
  findWidgets,
  summarizeElementorData,
  type BuildSpec,
  type ElementorNode,
} from '../wp/elementor.js';
import { compact, ok, requireBridge, requireConfirm, runTool, type ToolContext } from './context.js';

const widgetSpecSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    type: z.string().describe('Elementor widget name, e.g. heading, text-editor, button, image'),
    settings: z.record(z.unknown()).optional(),
    sections: z.array(sectionSpecSchema).optional(),
  }),
);

const columnSpecSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    size: z.number().min(1).max(100).optional(),
    settings: z.record(z.unknown()).optional(),
    widgets: z.array(widgetSpecSchema).optional(),
    sections: z.array(sectionSpecSchema).optional(),
  }),
);

const sectionSpecSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    settings: z.record(z.unknown()).optional(),
    columns: z.array(columnSpecSchema).optional(),
    widgets: z.array(widgetSpecSchema).optional(),
    container: z.boolean().optional(),
  }),
);

/** Elementor writes a JSON string; older installs may return an array. */
function decode(raw: unknown): ElementorNode[] | null {
  if (Array.isArray(raw)) return raw as ElementorNode[];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ElementorNode[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function readData(ctx: ToolContext, postId: number): Promise<{ data: ElementorNode[]; meta: Record<string, unknown> }> {
  const response = await ctx.client.bridge<Record<string, unknown>>('/elementor', {
    method: 'POST',
    body: { action: 'get', post_id: postId },
  });
  const data = decode(response.data) ?? [];
  return {
    data,
    meta: {
      post_id: response.post_id,
      title: response.title,
      post_type: response.post_type,
      status: response.status,
      link: response.link,
      edit_mode: response.edit_mode,
      template_type: response.template_type,
      el_version: response.el_version,
      page_template: response.page_template,
      top_level_elements: response.elements,
    },
  };
}

async function writeData(
  ctx: ToolContext,
  postId: number,
  data: ElementorNode[],
  snapshot = true,
): Promise<Record<string, unknown>> {
  return ctx.client.bridge<Record<string, unknown>>('/elementor', {
    method: 'POST',
    body: { action: 'set', post_id: postId, data, snapshot },
    timeoutMs: 60_000,
  });
}

function getNode(tree: ElementorNode[], path: string): ElementorNode {
  const parts = path.split('/').filter(Boolean).map(Number);
  let node: ElementorNode | undefined;
  let list: ElementorNode[] | undefined = tree;

  for (const index of parts) {
    node = list?.[index];
    if (!node) throw new Error(`Path "${path}" does not exist.`);
    list = node.elements;
  }
  if (!node) throw new Error(`Path "${path}" does not exist.`);
  return node;
}

export function registerElementorTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'wp_el_status',
    {
      title: 'Elementor status',
      description: 'Report whether Elementor (and Pro) is active, its version, and whether flexbox containers are enabled.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(ctx, 'wp_el_status', async () => {
        requireBridge(ctx);
        const result = await ctx.client.bridge<Record<string, unknown>>('/elementor', {
          method: 'POST',
          body: { action: 'status' },
        });
        return ok(result);
      }),
  );

  server.registerTool(
    'wp_el_widgets',
    {
      title: 'List Elementor widgets',
      description:
        'Enumerate every registered widget name (widgetType) with its title and category. Call this before building a page so you only reference widgets that actually exist on this site.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(ctx, 'wp_el_widgets', async () => {
        requireBridge(ctx);
        const result = await ctx.client.bridge<{ widgets: Array<Record<string, unknown>> }>('/elementor', {
          method: 'POST',
          body: { action: 'widgets' },
        });
        return ok({ count: result.widgets?.length ?? 0, widgets: result.widgets ?? [] }, 80_000);
      }),
  );

  server.registerTool(
    'wp_el_get',
    {
      title: 'Read an Elementor page',
      description:
        'Read the Elementor tree for a page. format=summary gives a compact outline (default); raw returns the full JSON tree for precise edits.',
      inputSchema: {
        post_id: z.number().int(),
        format: z.enum(['summary', 'raw', 'both']).default('summary'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(ctx, 'wp_el_get', async () => {
        requireBridge(ctx);
        const { data, meta } = await readData(ctx, args.post_id);
        return ok({
          meta,
          element_count: data.length,
          summary: args.format === 'raw' ? undefined : summarizeElementorData(data),
          data: args.format === 'summary' ? undefined : data,
        }, 90_000);
      }),
  );

  server.registerTool(
    'wp_el_build',
    {
      title: 'Build an Elementor page from a spec',
      description:
        'Convert a compact section/column/widget spec into Elementor data and (unless dry_run) write it. If post_id is omitted, a new page is created. Always inspect the dry_run output first. Widget settings use Elementor setting keys (e.g. heading: {title, header_size}; button: {text, link:{url}}).',
      inputSchema: {
        post_id: z.number().int().optional().describe('Existing page to overwrite'),
        create: z
          .object({
            title: z.string(),
            slug: z.string().optional(),
            status: z.enum(['publish', 'draft', 'private']).default('draft'),
            page_template: z.string().default('elementor_header_footer'),
          })
          .optional()
          .describe('Create a new page when post_id is absent'),
        spec: z.object({
          layout: z.enum(['section', 'container']).default('section'),
          page_settings: z.record(z.unknown()).optional(),
          sections: z.array(sectionSpecSchema),
        }),
        dry_run: z.boolean().default(true),
        confirm: z.string().optional().describe('Must be "overwrite" when writing to an existing page'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_el_build',
        async () => {
          requireBridge(ctx);

          const built = ensureIds(buildElementorData(args.spec as unknown as BuildSpec));
          const summary = summarizeElementorData(built);

          if (args.dry_run) {
            return ok({
              dry_run: true,
              widgets: findWidgets(built).length,
              tree: built,
              summary,
            }, 90_000);
          }

          let postId = args.post_id;

          if (!postId) {
            if (!args.create) throw new Error('Provide post_id or create{title}.');
            const created = await ctx.client.rest<Record<string, unknown>>('/pages', {
              method: 'POST',
              body: {
                title: args.create.title,
                slug: args.create.slug,
                status: args.create.status,
                template: args.create.page_template,
              },
            });
            postId = Number(created.id);
          } else {
            requireConfirm(args.confirm, 'overwrite', 'overwrite an existing Elementor page');
          }

          const write = await writeData(ctx, postId, built);

          if (args.spec.page_settings) {
            const encoded = JSON.stringify(args.spec.page_settings);
            await ctx.client.bridge('/php', {
              method: 'POST',
              body: {
                code: `$id = ${postId};\nupdate_post_meta($id, '_elementor_page_settings', wp_slash(${JSON.stringify(encoded)}));\nreturn ['ok'=>true];`,
                mode: 'php',
              },
            });
          }

          return ok({
            dry_run: false,
            post_id: postId,
            widgets: findWidgets(built).length,
            bytes: write.bytes,
            edit_link: `${ctx.site.url}/wp-admin/post.php?post=${postId}&action=elementor`,
            preview: write.preview,
          });
        },
        { action: 'elementor_build', target: String(args.post_id ?? args.create?.title) },
      ),
  );

  server.registerTool(
    'wp_el_set',
    {
      title: 'Write raw Elementor data',
      description:
        'Replace the whole Elementor tree for a page. Use wp_el_build for authored pages and this only when you already have valid Elementor JSON. Snapshots the previous tree automatically. Requires confirm:"overwrite".',
      inputSchema: {
        post_id: z.number().int(),
        data: z.union([z.array(z.unknown()), z.string()]).describe('Array tree or JSON string'),
        snapshot: z.boolean().default(true),
        confirm: z.string().describe('Must be "overwrite"'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_el_set',
        async () => {
          requireBridge(ctx);
          requireConfirm(args.confirm, 'overwrite', 'overwrite Elementor data');
          const result = await writeData(ctx, args.post_id, args.data as ElementorNode[], args.snapshot);
          return ok(result);
        },
        { action: 'elementor_set', target: String(args.post_id) },
      ),
  );

  server.registerTool(
    'wp_el_patch',
    {
      title: 'Patch widgets in place',
      description:
        'Update settings on specific nodes without rewriting the page. Paths come from wp_el_get (format=raw or summary), e.g. "0/1/2". Settings are deep-merged into the node.',
      inputSchema: {
        post_id: z.number().int(),
        patches: z
          .array(
            z.object({
              path: z.string().describe('Slash path of indexes, e.g. 0/0/1'),
              settings: z.record(z.unknown()),
            }),
          )
          .min(1),
        confirm: z.string().describe('Must be "patch"'),
        snapshot: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_el_patch',
        async () => {
          requireBridge(ctx);
          requireConfirm(args.confirm, 'patch', 'patch Elementor nodes');

          const { data } = await readData(ctx, args.post_id);
          if (!data.length) throw new Error('This page has no Elementor data yet. Use wp_el_build.');

          const applied: Array<Record<string, unknown>> = [];
          for (const patch of args.patches) {
            const node = getNode(data, patch.path);
            node.settings = deepMerge((node.settings ?? {}) as Record<string, unknown>, patch.settings);
            applied.push({ path: patch.path, elType: node.elType, widgetType: node.widgetType });
          }

          const result = await writeData(ctx, args.post_id, data, args.snapshot);
          return ok({ applied, ...result });
        },
        { action: 'elementor_patch', target: String(args.post_id) },
      ),
  );

  server.registerTool(
    'wp_el_snapshots',
    {
      title: 'List Elementor snapshots',
      description: 'List the five most recent automatic snapshots for a page (metadata only).',
      inputSchema: { post_id: z.number().int() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(ctx, 'wp_el_snapshots', async () => {
        requireBridge(ctx);
        const result = await ctx.client.bridge<Record<string, unknown>>('/elementor', {
          method: 'POST',
          body: { action: 'snapshots', post_id: args.post_id },
        });
        return ok(result);
      }),
  );

  server.registerTool(
    'wp_el_restore',
    {
      title: 'Restore an Elementor snapshot',
      description: 'Roll a page back to a snapshot index. The current tree is snapshotted first, so this is reversible.',
      inputSchema: {
        post_id: z.number().int(),
        index: z.number().int().min(0),
        confirm: z.string().describe('Must be "restore"'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_el_restore',
        async () => {
          requireBridge(ctx);
          requireConfirm(args.confirm, 'restore', 'restore a snapshot');
          const result = await ctx.client.bridge<Record<string, unknown>>('/elementor', {
            method: 'POST',
            body: { action: 'restore', post_id: args.post_id, index: args.index },
          });
          return ok(result);
        },
        { action: 'elementor_restore', target: `${args.post_id}#${args.index}` },
      ),
  );

  server.registerTool(
    'wp_el_clear_cache',
    {
      title: 'Clear Elementor cache',
      description: 'Regenerate Elementor CSS and flush the object cache. Run after bulk edits if the front end looks stale.',
      inputSchema: {},
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    () =>
      runTool(
        ctx,
        'wp_el_clear_cache',
        async () => {
          requireBridge(ctx);
          const result = await ctx.client.bridge<Record<string, unknown>>('/elementor', {
            method: 'POST',
            body: { action: 'clear_cache' },
            timeoutMs: 60_000,
          });
          return ok(result);
        },
        { action: 'elementor_clear_cache' },
      ),
  );
}
