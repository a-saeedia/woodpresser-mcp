/**
 * Elementor data model helpers.
 *
 * Elementor stores a page as an array tree in the `_elementor_data` post meta:
 *   section | container -> column -> widget
 * This module converts a compact, human/agent friendly spec into that tree and
 * back into a readable summary.
 */
import { randomBytes } from 'node:crypto';

export type ElementorNode = {
  id: string;
  elType: 'section' | 'column' | 'container' | 'widget';
  settings: Record<string, unknown>;
  elements: ElementorNode[];
  isInner?: boolean;
  widgetType?: string;
};

export interface WidgetSpec {
  /** Elementor widget name, e.g. heading, text-editor, button, image. */
  type: string;
  settings?: Record<string, unknown>;
  /** Nested elements, only meaningful for structural widgets. */
  sections?: SectionSpec[];
}

export interface ColumnSpec {
  /** 1-100 percentage width. */
  size?: number;
  settings?: Record<string, unknown>;
  widgets?: WidgetSpec[];
  sections?: SectionSpec[];
}

export interface SectionSpec {
  settings?: Record<string, unknown>;
  columns?: ColumnSpec[];
  /** Use a flexbox container instead of the legacy section/column pair. */
  container?: boolean;
  /** Widgets placed directly inside a container. */
  widgets?: WidgetSpec[];
}

export interface BuildSpec {
  /** `section` (default) or `container` (Elementor 3.6+ flexbox). */
  layout?: 'section' | 'container';
  page_settings?: Record<string, unknown>;
  sections: SectionSpec[];
}

export function elementId(): string {
  return randomBytes(4).toString('hex').slice(0, 7);
}

function widgetNode(spec: WidgetSpec): ElementorNode {
  if (!spec || typeof spec.type !== 'string' || !spec.type.trim()) {
    throw new Error('Every widget needs a non-empty `type` (Elementor widget name).');
  }
  const node: ElementorNode = {
    id: elementId(),
    elType: 'widget',
    settings: (spec.settings ?? {}) as Record<string, unknown>,
    elements: [],
    widgetType: spec.type.trim(),
  };
  if (Array.isArray(spec.sections) && spec.sections.length) {
    node.elements = spec.sections.map((section) => sectionNode(section, true));
  }
  return node;
}

function columnNode(spec: ColumnSpec, index: number, total: number): ElementorNode {
  const size = spec.size ?? Math.round(100 / Math.max(total, 1));
  const children: ElementorNode[] = [];
  for (const widget of spec.widgets ?? []) children.push(widgetNode(widget));
  for (const section of spec.sections ?? []) children.push(sectionNode(section, true));

  return {
    id: elementId(),
    elType: 'column',
    settings: {
      _column_size: size,
      _inline_size: size,
      ...(spec.settings ?? {}),
    },
    elements: children,
    isInner: false,
    ...(index === -1 ? {} : {}),
  } as ElementorNode;
}

function containerNode(spec: SectionSpec): ElementorNode {
  const children: ElementorNode[] = [];
  for (const widget of spec.widgets ?? []) children.push(widgetNode(widget));
  for (const column of spec.columns ?? []) {
    // Containers are flat: promote column children into the container.
    for (const widget of column.widgets ?? []) children.push(widgetNode(widget));
    for (const inner of column.sections ?? []) children.push(sectionNode(inner, true));
  }
  return {
    id: elementId(),
    elType: 'container',
    settings: {
      content_width: 'boxed',
      flex_direction: 'column',
      ...(spec.settings ?? {}),
    },
    elements: children,
    isInner: false,
  };
}

function sectionNode(spec: SectionSpec, isInner = false, layout: 'section' | 'container' = 'section'): ElementorNode {
  if (spec.container || layout === 'container') return containerNode({ ...spec, container: true });

  const columns = spec.columns ?? [];
  const nodes = columns.map((column, index) => columnNode(column, index, columns.length));

  return {
    id: elementId(),
    elType: 'section',
    settings: {
      layout: 'boxed',
      ...(spec.settings ?? {}),
    },
    elements: nodes,
    isInner,
  };
}

/** Convert a compact spec into a full Elementor tree. */
export function buildElementorData(spec: BuildSpec): ElementorNode[] {
  if (!Array.isArray(spec.sections) || spec.sections.length === 0) {
    throw new Error('`sections` must contain at least one section.');
  }
  const layout = spec.layout ?? 'section';
  return spec.sections.map((section) => sectionNode(section, false, layout));
}

/** Readable outline of an existing tree. */
export function summarizeElementorData(data: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(data)) return [];

  const walk = (node: unknown, depth: number): Record<string, unknown> | null => {
    if (!node || typeof node !== 'object') return null;
    const element = node as ElementorNode;
    const children = Array.isArray(element.elements) ? element.elements : [];
    const entry: Record<string, unknown> = {
      id: element.id,
      elType: element.elType,
    };
    if (element.widgetType) entry.widgetType = element.widgetType;
    if (depth === 0) entry.settings = element.settings ?? {};

    const mapped = children.map((child) => walk(child, depth + 1)).filter(Boolean) as Array<
      Record<string, unknown>
    >;
    if (mapped.length) entry.children = mapped;
    return entry;
  };

  return data.map((node) => walk(node, 0)).filter(Boolean) as Array<Record<string, unknown>>;
}

/** Find every widget of a given type with its path. */
export function findWidgets(data: unknown, widgetType?: string): Array<{ path: string; widgetType: string; settings: unknown }> {
  const out: Array<{ path: string; widgetType: string; settings: unknown }> = [];

  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    const element = node as ElementorNode;
    if (element.elType === 'widget') {
      if (!widgetType || element.widgetType === widgetType) {
        out.push({ path, widgetType: element.widgetType ?? '', settings: element.settings ?? {} });
      }
    }
    (element.elements ?? []).forEach((child, index) => walk(child, `${path}/${index}`));
  };

  if (Array.isArray(data)) data.forEach((node, index) => walk(node, String(index)));
  return out;
}

/** Ensure every node has an id (repairs hand-written or imported data). */
export function ensureIds(data: ElementorNode[]): ElementorNode[] {
  const seen = new Set<string>();
  const walk = (node: ElementorNode) => {
    if (!node.id || seen.has(node.id)) node.id = elementId();
    seen.add(node.id);
    node.elements = Array.isArray(node.elements) ? node.elements : [];
    node.settings = node.settings && typeof node.settings === 'object' ? node.settings : {};
    for (const child of node.elements) walk(child);
  };
  for (const node of data) walk(node);
  return data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge settings. Plain objects merge recursively, arrays and scalars
 * replace, and `undefined` values are ignored (so a partial patch never erases
 * a sibling key). Elementor settings are nested (typography, background, link),
 * which is why a shallow spread is not enough.
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value;
  }
  return out as T;
}
