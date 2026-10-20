/**
 * MCP client registration. Writes a local server entry into the config file of
 * the client the user actually runs (opencode, Claude Code, VS Code).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  removeNestedProperty,
  stripJsonc,
  upsertNestedProperty,
  validateJsonc,
} from '../util/jsonc.js';

export type McpTarget = 'opencode' | 'claude' | 'vscode';

export interface InstallOptions {
  name: string;
  nodePath: string;
  cliPath: string;
  site?: string;
  scope: 'user' | 'project';
  cwd: string;
}

export interface InstallResult {
  target: McpTarget;
  path: string;
  changed: boolean;
  created: boolean;
}

function args(opts: InstallOptions): string[] {
  const list = [opts.cliPath, 'mcp'];
  if (opts.site) list.push('--site', opts.site);
  return list;
}

function opencodeFile(scope: 'user' | 'project', cwd: string): string {
  if (scope === 'project') {
    const jsonc = join(cwd, 'opencode.jsonc');
    const json = join(cwd, 'opencode.json');
    const nested = join(cwd, '.opencode', 'opencode.json');
    if (existsSync(jsonc)) return jsonc;
    if (existsSync(json)) return json;
    if (existsSync(nested)) return nested;
    return jsonc;
  }

  const dir = join(homedir(), '.config', 'opencode');
  const jsonc = join(dir, 'opencode.jsonc');
  const json = join(dir, 'opencode.json');
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc;
}

function targetFile(target: McpTarget, scope: 'user' | 'project', cwd: string): string {
  if (target === 'opencode') return opencodeFile(scope, cwd);
  if (target === 'claude') {
    return scope === 'user' ? join(homedir(), '.mcp.json') : join(cwd, '.mcp.json');
  }
  return join(cwd, '.vscode', 'mcp.json');
}

const PARENT_KEY: Record<McpTarget, string> = {
  opencode: 'mcp',
  claude: 'mcpServers',
  vscode: 'servers',
};

function entryFor(target: McpTarget, opts: InstallOptions): unknown {
  const argv = args(opts);
  if (target === 'opencode') {
    return { type: 'local', command: [opts.nodePath, ...argv], enabled: true };
  }
  if (target === 'claude') {
    return { command: opts.nodePath, args: argv };
  }
  return { type: 'stdio', command: opts.nodePath, args: argv };
}

function readOrInit(path: string): { text: string; created: boolean } {
  if (existsSync(path)) return { text: readFileSync(path, 'utf8'), created: false };
  return { text: '{\n}\n', created: true };
}

function backup(path: string): void {
  if (!existsSync(path)) return;
  copyFileSync(path, `${path}.woodpresser.bak`);
}

export function installMcp(target: McpTarget, opts: InstallOptions): InstallResult {
  const path = targetFile(target, opts.scope, opts.cwd);
  const { text, created } = readOrInit(path);
  const parent = PARENT_KEY[target];

  const updated = upsertNestedProperty(text, parent, opts.name, entryFor(target, opts));
  const validation = validateJsonc(updated);
  if (!validation.ok) {
    throw new Error(`Refusing to write ${path}: result would be invalid JSON (${validation.error}).`);
  }

  const parsed = JSON.parse(stripJsonc(updated)) as Record<string, Record<string, unknown>>;
  if (!parsed[parent]?.[opts.name]) {
    throw new Error(`Refusing to write ${path}: entry ${parent}.${opts.name} missing after edit.`);
  }

  mkdirSync(dirname(path), { recursive: true });
  backup(path);
  writeFileSync(path, updated, 'utf8');

  return { target, path, changed: updated !== text, created };
}

export function uninstallMcp(
  target: McpTarget,
  name: string,
  scope: 'user' | 'project',
  cwd: string,
): { path: string; removed: boolean } {
  const path = targetFile(target, scope, cwd);
  if (!existsSync(path)) return { path, removed: false };

  const text = readFileSync(path, 'utf8');
  const updated = removeNestedProperty(text, PARENT_KEY[target], name);
  if (updated === text) return { path, removed: false };

  if (!validateJsonc(updated).ok) {
    throw new Error(`Refusing to write ${path}: result would be invalid JSON.`);
  }

  backup(path);
  writeFileSync(path, updated, 'utf8');
  return { path, removed: true };
}

export const ALL_TARGETS: McpTarget[] = ['opencode', 'claude', 'vscode'];
