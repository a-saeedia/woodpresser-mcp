/**
 * Core WordPress tools: site introspection, content, media, terms, users,
 * plugins, themes, settings and search. Uses only core REST routes.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { compact, ok, requireConfirm, runTool, type ToolContext } from './context.js';

const CONTENT_TYPES = {
  post: 'posts',
  page: 'pages',
  posts: 'posts',
  pages: 'pages',
} as const;

type ContentType = keyof typeof CONTENT_TYPES;

function collection(type: string): string {
  const key = (type || 'post').toLowerCase() as ContentType;
  const route = CONTENT_TYPES[key];
  if (!route) {
    throw new Error(`Unsupported type "${type}". Use post or page.`);
  }
  return route;
}

const LIST_FIELDS =
  'id,date,modified,slug,status,link,type,title,excerpt,categories,tags,featured_media,parent,menu_order,author';

export function registerCoreTools(server: McpServer, ctx: ToolContext): void {
  /* ---------------------------------------------------------------- site */

  server.registerTool(
    'wp_site_info',
    {
      title: 'WordPress site info',
      description:
        'Identify the connected site: name, description, URL, REST namespaces, the authenticated user and their capabilities, plus bridge/Elementor/plugin versions. Start here when you inherit a project.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(ctx, 'wp_site_info', async () => {
        const [index, me, probe] = await Promise.all([
          ctx.client.request<Record<string, unknown>>('/wp-json/'),
          ctx.client.rest<Record<string, unknown>>('/users/me', { query: { context: 'edit' } }),
          ctx.client.probe(),
        ]);

        return ok({
          site: ctx.siteName,
          url: ctx.site.url,
          name: index.name,
          description: index.description,
          home: index.home,
          gmt_offset: index.gmt_offset,
          namespaces: index.namespaces,
          authentication: index.authentication,
          user: {
            id: me.id,
            username: me.slug,
            name: me.name,
            roles: me.roles,
            capabilities_count: me.capabilities ? Object.keys(me.capabilities as object).length : undefined,
            is_super_admin: me.is_super_admin,
          },
          bridge: probe.bridge ? probe.data : { installed: false, error: probe.error },
          modes: ctx.site.modes,
        });
      }),
  );

  server.registerTool(
    'wp_health_check',
    {
      title: 'WordPress health check',
      description:
        'Diagnose connectivity in layers: REST reachable, credentials accepted, bridge claimed, Elementor present, permalinks, and debug log size. Use before blaming the code.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(ctx, 'wp_health_check', async () => {
        const checks: Array<Record<string, unknown>> = [];

        try {
          const index = await ctx.client.request<Record<string, unknown>>('/wp-json/');
          checks.push({ check: 'rest_api', ok: true, detail: String(index.name ?? '') });
        } catch (error) {
          checks.push({ check: 'rest_api', ok: false, detail: (error as Error).message });
        }

        try {
          const me = await ctx.client.rest<Record<string, unknown>>('/users/me', { query: { context: 'edit' } });
          checks.push({ check: 'auth', ok: true, detail: `user ${me.slug} (id ${me.id})` });
        } catch (error) {
          checks.push({ check: 'auth', ok: false, detail: (error as Error).message });
        }

        try {
          const ping = await ctx.client.bridge<Record<string, unknown>>('/ping');
          checks.push({
            check: 'bridge',
            ok: true,
            detail: `v${ping.plugin_version} claimed=${ping.claimed}`,
            flags: ping.flags,
            elementor: ping.elementor,
            wp_version: ping.wp_version,
            php_version: ping.php_version,
          });
        } catch (error) {
          checks.push({ check: 'bridge', ok: false, detail: (error as Error).message });
        }

        try {
          const settings = await ctx.client.rest<Record<string, unknown>>('/settings');
          checks.push({
            check: 'permalinks',
            ok: Boolean(settings.permalink_structure),
            detail: String(settings.permalink_structure ?? '(plain)'),
          });
        } catch {
          checks.push({ check: 'permalinks', ok: false, detail: 'settings not readable' });
        }

        const healthy = checks.filter((c) => c.check !== 'permalinks').every((c) => c.ok);
        return ok({ healthy, checks });
      }),
  );

  /* ------------------------------------------------------------- content */

  server.registerTool(
    'wp_content_list',
    {
      title: 'List posts or pages',
      description:
        'List content with filters. Returns compact rows by default (no full content). Use wp_content_get for the body.',
      inputSchema: {
        type: z.enum(['post', 'page']).default('post').describe('post or page'),
        status: z
          .enum(['publish', 'draft', 'pending', 'private', 'future', 'any'])
          .optional()
          .describe('Post status filter'),
        search: z.string().optional().describe('Free-text search'),
        slug: z.string().optional().describe('Exact slug'),
        author: z.number().int().optional(),
        categories: z.array(z.number().int()).optional(),
        tags: z.array(z.number().int()).optional(),
        parent: z.number().int().optional().describe('Parent ID (pages)'),
        orderby: z.enum(['date', 'modified', 'title', 'menu_order', 'id']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        per_page: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
        include_content: z.boolean().default(false).describe('Include rendered content'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(ctx, 'wp_content_list', async () => {
        const fields = args.include_content ? `${LIST_FIELDS},content` : LIST_FIELDS;
        const query: Record<string, string | number | boolean | undefined> = {
          _fields: fields,
          per_page: args.per_page,
          page: args.page,
          status: args.status,
          search: args.search,
          slug: args.slug,
          author: args.author,
          categories: args.categories?.join(','),
          tags: args.tags?.join(','),
          parent: args.parent,
          orderby: args.orderby,
          order: args.order,
        };

        const result = await ctx.client.paginate<Record<string, unknown>>(
          `/${collection(args.type)}`,
          query,
          args.per_page,
          1,
        );

        return ok({ type: args.type, total: result.total, count: result.items.length, items: result.items });
      }),
  );

  server.registerTool(
    'wp_content_get',
    {
      title: 'Get a post or page',
      description: 'Fetch a single item by ID or slug, including raw and rendered content plus open Graph-ish fields.',
      inputSchema: {
        id: z.number().int().optional(),
        slug: z.string().optional(),
        type: z.enum(['post', 'page']).default('post'),
        context: z.enum(['view', 'edit']).default('edit'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(ctx, 'wp_content_get', async () => {
        if (!args.id && !args.slug) throw new Error('Provide id or slug.');
        const route = collection(args.type);

        if (args.id) {
          const item = await ctx.client.rest<Record<string, unknown>>(`/${route}/${args.id}`, {
            query: { context: args.context },
          });
          return ok({ item });
        }

        const items = await ctx.client.rest<Array<Record<string, unknown>>>(`/${route}`, {
          query: { slug: args.slug!, context: args.context },
        });
        if (!items.length) throw new Error(`No ${args.type} with slug "${args.slug}".`);
        return ok({ item: items[0] });
      }),
  );

  server.registerTool(
    'wp_content_create',
    {
      title: 'Create a post or page',
      description: 'Create content. Returns the new ID and link. Supports meta, taxonomy terms and page templates.',
      inputSchema: {
        type: z.enum(['post', 'page']).default('post'),
        title: z.string(),
        content: z.string().default('').describe('Block or classic HTML'),
        status: z.enum(['publish', 'draft', 'pending', 'private', 'future']).default('draft'),
        slug: z.string().optional(),
        excerpt: z.string().optional(),
        date: z.string().optional().describe('ISO date, required for status=future'),
        parent: z.number().int().optional(),
        menu_order: z.number().int().optional(),
        template: z.string().optional().describe('Page template, e.g. elementor_header_footer'),
        categories: z.array(z.number().int()).optional(),
        tags: z.array(z.number().int()).optional(),
        featured_media: z.number().int().optional(),
        meta: z.record(z.unknown()).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_content_create',
        async () => {
          const body = compact({
            title: args.title,
            content: args.content,
            status: args.status,
            slug: args.slug,
            excerpt: args.excerpt,
            date: args.date,
            parent: args.parent,
            menu_order: args.menu_order,
            template: args.template,
            categories: args.categories,
            tags: args.tags,
            featured_media: args.featured_media,
            meta: args.meta,
          });

          const created = await ctx.client.rest<Record<string, unknown>>(`/${collection(args.type)}`, {
            method: 'POST',
            body,
          });

          return ok({
            id: created.id,
            status: created.status,
            link: created.link,
            edit_link: `${ctx.site.url}/wp-admin/post.php?post=${created.id}&action=edit`,
          });
        },
        { action: 'content_create', target: args.title },
      ),
  );

  server.registerTool(
    'wp_content_update',
    {
      title: 'Update a post or page',
      description: 'Patch an existing item. Only supplied fields change. For a full Elementor rewrite use wp_el_set instead.',
      inputSchema: {
        id: z.number().int(),
        type: z.enum(['post', 'page']).default('post'),
        title: z.string().optional(),
        content: z.string().optional(),
        status: z.enum(['publish', 'draft', 'pending', 'private', 'future']).optional(),
        slug: z.string().optional(),
        excerpt: z.string().optional(),
        parent: z.number().int().optional(),
        menu_order: z.number().int().optional(),
        template: z.string().optional(),
        categories: z.array(z.number().int()).optional(),
        tags: z.array(z.number().int()).optional(),
        featured_media: z.number().int().optional(),
        meta: z.record(z.unknown()).optional(),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_content_update',
        async () => {
          const { id, type, ...rest } = args;
          const body = compact(rest as Record<string, unknown>);
          if (Object.keys(body).length === 0) throw new Error('Nothing to update.');

          const updated = await ctx.client.rest<Record<string, unknown>>(`/${collection(type)}/${id}`, {
            method: 'POST',
            body,
          });

          return ok({ id: updated.id, status: updated.status, modified: updated.modified, link: updated.link });
        },
        { action: 'content_update', target: String(args.id) },
      ),
  );

  server.registerTool(
    'wp_content_delete',
    {
      title: 'Delete (trash) a post or page',
      description: 'Moves to trash by default. force=true bypasses trash forever and requires confirm:"delete".',
      inputSchema: {
        id: z.number().int(),
        type: z.enum(['post', 'page']).default('post'),
        force: z.boolean().default(false),
        confirm: z.string().optional().describe('Must be "delete" when force=true'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_content_delete',
        async () => {
          if (args.force) requireConfirm(args.confirm, 'delete', 'permanently delete content');
          const result = await ctx.client.rest<Record<string, unknown>>(
            `/${collection(args.type)}/${args.id}`,
            { method: 'DELETE', query: { force: args.force } },
          );
          return ok({ id: args.id, deleted: Boolean(result.deleted), previous: result.previous });
        },
        { action: args.force ? 'content_delete_force' : 'content_trash', target: String(args.id) },
      ),
  );

  /* --------------------------------------------------------------- media */

  server.registerTool(
    'wp_media_list',
    {
      title: 'List media',
      description: 'List attachments with optional MIME filter and search.',
      inputSchema: {
        mime_type: z.string().optional().describe('e.g. image/jpeg'),
        search: z.string().optional(),
        per_page: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(ctx, 'wp_media_list', async () => {
        const result = await ctx.client.paginate<Record<string, unknown>>(
          '/media',
          {
            mime_type: args.mime_type,
            search: args.search,
            _fields: 'id,date,slug,title,mime_type,source_url,media_details,alt_text',
          },
          args.per_page,
          1,
        );
        return ok({ total: result.total, items: result.items });
      }),
  );

  server.registerTool(
    'wp_media_upload',
    {
      title: 'Upload media',
      description: 'Upload a local file to the media library. Provide path, or url to sideload a remote file.',
      inputSchema: {
        path: z.string().optional().describe('Local absolute path'),
        url: z.string().optional().describe('Remote URL to download then upload'),
        filename: z.string().optional(),
        alt_text: z.string().optional(),
        title: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_media_upload',
        async () => {
          if (!args.path && !args.url) throw new Error('Provide path or url.');

          let buffer: Buffer;
          let filename: string;

          if (args.path) {
            buffer = await readFile(args.path);
            filename = args.filename ?? basename(args.path);
          } else {
            const response = await fetch(args.url!);
            if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
            buffer = Buffer.from(await response.arrayBuffer());
            const fromUrl = new URL(args.url!);
            filename = args.filename ?? (basename(fromUrl.pathname) || 'upload.bin');
          }

          const mime = guessMime(filename);
          const uploaded = await ctx.client.uploadBinary(buffer, filename, mime);

          if (args.alt_text || args.title) {
            await ctx.client.rest(`/media/${uploaded.id}`, {
              method: 'POST',
              body: compact({ alt_text: args.alt_text, title: args.title }),
            });
          }

          return ok({
            id: uploaded.id,
            url: uploaded.source_url,
            mime_type: uploaded.mime_type,
            bytes: buffer.byteLength,
          });
        },
        { action: 'media_upload', target: args.filename ?? args.url },
      ),
  );

  /* --------------------------------------------------------------- terms */

  server.registerTool(
    'wp_terms_list',
    {
      title: 'List taxonomy terms',
      description: 'List categories, tags or any public taxonomy.',
      inputSchema: {
        taxonomy: z.enum(['categories', 'tags']).default('categories'),
        search: z.string().optional(),
        per_page: z.number().int().min(1).max(100).default(50),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(ctx, 'wp_terms_list', async () => {
        const result = await ctx.client.paginate<Record<string, unknown>>(
          `/${args.taxonomy}`,
          { search: args.search, _fields: 'id,name,slug,count,parent,description' },
          args.per_page,
          1,
        );
        return ok({ taxonomy: args.taxonomy, total: result.total, items: result.items });
      }),
  );

  server.registerTool(
    'wp_term_create',
    {
      title: 'Create a term',
      description: 'Create a category or tag.',
      inputSchema: {
        taxonomy: z.enum(['categories', 'tags']).default('categories'),
        name: z.string(),
        slug: z.string().optional(),
        description: z.string().optional(),
        parent: z.number().int().optional(),
      },
      annotations: { openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_term_create',
        async () => {
          const created = await ctx.client.rest<Record<string, unknown>>(`/${args.taxonomy}`, {
            method: 'POST',
            body: compact({
              name: args.name,
              slug: args.slug,
              description: args.description,
              parent: args.parent,
            }),
          });
          return ok({ id: created.id, name: created.name, slug: created.slug });
        },
        { action: 'term_create', target: args.name },
      ),
  );

  /* --------------------------------------------------------------- users */

  server.registerTool(
    'wp_users_list',
    {
      title: 'List users',
      description: 'List users with roles. Requires administrator credentials.',
      inputSchema: {
        search: z.string().optional(),
        roles: z.array(z.string()).optional(),
        per_page: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(ctx, 'wp_users_list', async () => {
        const result = await ctx.client.paginate<Record<string, unknown>>(
          '/users',
          {
            search: args.search,
            roles: args.roles?.join(','),
            context: 'edit',
            _fields: 'id,name,slug,email,roles,registered_date,last_login',
          },
          args.per_page,
          1,
        );
        return ok({ total: result.total, items: result.items });
      }),
  );

  /* ------------------------------------------------- plugins and themes */

  server.registerTool(
    'wp_plugins_list',
    {
      title: 'List plugins',
      description: 'List installed plugins with status and available updates.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(ctx, 'wp_plugins_list', async () => {
        const plugins = await ctx.client.rest<Array<Record<string, unknown>>>('/plugins', {
          query: { _fields: 'plugin,name,version,status,update,description,author' },
        });
        return ok({ count: plugins.length, plugins });
      }),
  );

  server.registerTool(
    'wp_plugin_action',
    {
      title: 'Plugin action',
      description:
        'Activate, deactivate, install (from wordpress.org by slug) or delete a plugin. Deletion requires confirm:"delete". Activating an untrusted plugin is a security decision.',
      inputSchema: {
        action: z.enum(['activate', 'deactivate', 'install', 'delete']),
        plugin: z.string().optional().describe('Plugin file, e.g. elementor/elementor.php'),
        slug: z.string().optional().describe('wordpress.org slug, for install'),
        confirm: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_plugin_action',
        async () => {
          if (args.action === 'install') {
            if (!args.slug) throw new Error('install requires slug.');
            const installed = await ctx.client.rest<Record<string, unknown>>('/plugins', {
              method: 'POST',
              body: { slug: args.slug, status: 'inactive' },
            });
            return ok({ action: 'install', plugin: installed.plugin, status: installed.status });
          }

          if (!args.plugin) throw new Error(`${args.action} requires plugin.`);
          if (args.action === 'delete') requireConfirm(args.confirm, 'delete', 'delete a plugin');

          const result = await ctx.client.rest<Record<string, unknown>>(
            `/plugins/${encodeURIComponent(args.plugin)}`,
            {
              method: args.action === 'delete' ? 'DELETE' : 'POST',
              body: args.action === 'delete' ? undefined : { status: args.action === 'activate' ? 'active' : 'inactive' },
            },
          );

          return ok({ action: args.action, plugin: result.plugin, status: result.status, deleted: result.deleted });
        },
        { action: `plugin_${args.action}`, target: args.plugin ?? args.slug },
      ),
  );

  server.registerTool(
    'wp_themes_list',
    {
      title: 'List themes',
      description: 'List installed themes and which one is active.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(ctx, 'wp_themes_list', async () => {
        const themes = await ctx.client.rest<Array<Record<string, unknown>>>('/themes', {
          query: { _fields: 'stylesheet,name,version,status,is_block_theme,author' },
        });
        return ok({
          active: themes.find((theme) => theme.status === 'active')?.stylesheet ?? null,
          themes,
        });
      }),
  );

  server.registerTool(
    'wp_theme_activate',
    {
      title: 'Activate a theme',
      description: 'Switch the active theme. Changing themes on a live site is high-impact; prefer a staging copy.',
      inputSchema: {
        stylesheet: z.string().describe('Theme directory slug'),
        confirm: z.string().optional().describe('Must be "activate"'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_theme_activate',
        async () => {
          requireConfirm(args.confirm, 'activate', 'switch the active theme');
          const result = await ctx.client.rest<Record<string, unknown>>(
            `/themes/${encodeURIComponent(args.stylesheet)}`,
            { method: 'POST', body: { status: 'active' } },
          );
          return ok({ active: result.stylesheet, status: result.status });
        },
        { action: 'theme_activate', target: args.stylesheet },
      ),
  );

  /* ------------------------------------------------------------ settings */

  server.registerTool(
    'wp_settings_get',
    {
      title: 'Read site settings',
      description: 'Read the REST-exposed site settings (title, description, timezone, permalinks, front page).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      runTool(ctx, 'wp_settings_get', async () => {
        const settings = await ctx.client.rest<Record<string, unknown>>('/settings');
        return ok({ settings });
      }),
  );

  server.registerTool(
    'wp_settings_set',
    {
      title: 'Update site settings',
      description: 'Update REST-exposed settings. Arbitrary options need wp_php_run or wp_db_query.',
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional(),
        show_on_front: z.enum(['posts', 'page']).optional(),
        page_on_front: z.number().int().optional(),
        page_for_posts: z.number().int().optional(),
        posts_per_page: z.number().int().optional(),
        timezone_string: z.string().optional(),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(
        ctx,
        'wp_settings_set',
        async () => {
          const body = compact(args as Record<string, unknown>);
          if (!Object.keys(body).length) throw new Error('Nothing to update.');
          const settings = await ctx.client.rest<Record<string, unknown>>('/settings', {
            method: 'POST',
            body,
          });
          return ok({ settings });
        },
        { action: 'settings_set', detail: args },
      ),
  );

  /* -------------------------------------------------------------- search */

  server.registerTool(
    'wp_search',
    {
      title: 'Search the site',
      description: 'Search across posts, pages and media in one call. Use this to locate content before editing it.',
      inputSchema: {
        query: z.string(),
        per_page: z.number().int().min(1).max(50).default(20),
        subtype: z.enum(['post', 'page', 'any']).default('any'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(ctx, 'wp_search', async () => {
        const items = await ctx.client.rest<Array<Record<string, unknown>>>('/search', {
          query: {
            search: args.query,
            per_page: args.per_page,
            subtype: args.subtype === 'any' ? undefined : args.subtype,
          },
        });
        return ok({ query: args.query, count: items.length, results: items });
      }),
  );
}

function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    txt: 'text/plain',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}
