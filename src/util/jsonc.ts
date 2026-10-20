/**
 * Minimal JSONC editor.
 *
 * Config files like opencode.jsonc contain comments and trailing commas; a
 * full parse + re-serialize would destroy them. This module performs surgical,
 * position-aware edits of individual properties and leaves everything else
 * byte-identical.
 */

export interface PropertySpan {
  name: string;
  keyStart: number;
  /** Index of the first character of the value. */
  valueStart: number;
  /** Index just past the last character of the value. */
  valueEnd: number;
}

export interface ObjectSpan {
  open: number;
  close: number;
  props: PropertySpan[];
}

/** Remove comments and trailing commas so JSON.parse can validate the result. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let inLine = false;
  let inBlock = false;

  while (i < text.length) {
    const char = text[i]!;
    const next = text[i + 1];

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (char === '"') inString = false;
      i += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    out += char;
    i += 1;
  }

  return out.replace(/,(\s*[}\]])/g, '$1');
}

function skipTrivia(text: string, index: number): number {
  let i = index;
  while (i < text.length) {
    const char = text[i]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\uFEFF') {
      i += 1;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function scanString(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '"') return i + 1;
    i += 1;
  }
  throw new Error('Unterminated string in JSONC file.');
}

/**
 * Return the index just past the last significant character of a value.
 * Whitespace and comments between the value and the next separator are not
 * part of the span, so replacing a value never swallows the indentation of the
 * closing brace.
 */
function scanValue(text: string, index: number): number {
  let i = index;
  let depth = 0;
  let last = index;

  while (i < text.length) {
    const char = text[i]!;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\uFEFF') {
      i += 1;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === '"') {
      i = scanString(text, i);
      last = i;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      i += 1;
      last = i;
      continue;
    }
    if (char === '}' || char === ']') {
      if (depth === 0) return last;
      depth -= 1;
      i += 1;
      last = i;
      continue;
    }
    if (char === ',' && depth === 0) return last;
    i += 1;
    last = i;
  }
  return last;
}

/** Parse the object starting at `start` (absolute offsets in the result). */
export function parseObjectAt(text: string, start: number): ObjectSpan {
  const open = skipTrivia(text, start);
  if (text[open] !== '{') throw new Error(`Expected an object at offset ${open}.`);

  const props: PropertySpan[] = [];
  let i = open + 1;

  for (;;) {
    i = skipTrivia(text, i);
    if (i >= text.length) throw new Error('Unterminated object.');
    if (text[i] === '}') return { open, close: i, props };
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] !== '"') throw new Error(`Expected a property name at offset ${i}.`);

    const keyStart = i;
    const keyEnd = scanString(text, i);
    const name = JSON.parse(text.slice(keyStart, keyEnd)) as string;

    i = skipTrivia(text, keyEnd);
    if (text[i] !== ':') throw new Error(`Expected ":" after "${name}".`);
    i = skipTrivia(text, i + 1);

    const valueStart = i;
    const valueEnd = scanValue(text, valueStart);
    props.push({ name, keyStart, valueStart, valueEnd });
    i = valueEnd;
  }
}

function lineIndent(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const line = text.slice(lineStart, index);
  const match = line.match(/^[ \t]*/);
  return match?.[0] ?? '';
}

/** Re-indent a JSON blob to sit under a given base indent. */
export function indentJson(value: unknown, baseIndent: string): string {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : baseIndent + line))
    .join('\n');
}

function insertProperty(text: string, span: ObjectSpan, name: string, value: unknown): string {
  const keyIndent = `${lineIndent(text, span.close)}  `;
  const body = indentJson(value, keyIndent);
  // A trailing comma before the closing brace is legal JSONC: adding another
  // one would produce ",," and break the file.
  const last = span.props[span.props.length - 1];
  const next = last ? skipTrivia(text, last.valueEnd) : -1;
  const hasTrailingComma = next >= 0 && text[next] === ',';
  const prefix = span.props.length > 0 && !hasTrailingComma ? ',' : '';
  const insertion = `${prefix}\n${keyIndent}"${name}": ${body}\n${lineIndent(text, span.close)}`;
  return text.slice(0, span.close) + insertion + text.slice(span.close);
}

function replaceProperty(text: string, _span: ObjectSpan, prop: PropertySpan, value: unknown): string {
  // Align with insertProperty so a second upsert of the same value is a no-op.
  const keyIndent = lineIndent(text, prop.keyStart);
  return text.slice(0, prop.valueStart) + indentJson(value, keyIndent) + text.slice(prop.valueEnd);
}

/** Insert or replace a property of the root object. */
export function upsertRootProperty(text: string, name: string, value: unknown): string {
  const root = parseObjectAt(text, 0);
  const existing = root.props.find((prop) => prop.name === name);
  return existing ? replaceProperty(text, root, existing, value) : insertProperty(text, root, name, value);
}

/** Insert or replace a property inside a root object's child object. */
export function upsertNestedProperty(
  text: string,
  parentName: string,
  name: string,
  value: unknown,
): string {
  const root = parseObjectAt(text, 0);
  const parent = root.props.find((prop) => prop.name === parentName);
  if (!parent) return upsertRootProperty(text, parentName, { [name]: value });

  const child = parseObjectAt(text, parent.valueStart);
  const existing = child.props.find((prop) => prop.name === name);
  return existing ? replaceProperty(text, child, existing, value) : insertProperty(text, child, name, value);
}

/** Remove a property from a root object's child object. */
export function removeNestedProperty(text: string, parentName: string, name: string): string {
  const root = parseObjectAt(text, 0);
  const parent = root.props.find((prop) => prop.name === parentName);
  if (!parent) return text;

  const child = parseObjectAt(text, parent.valueStart);
  const index = child.props.findIndex((prop) => prop.name === name);
  if (index === -1) return text;

  const prop = child.props[index]!;
  const isLast = index === child.props.length - 1;
  let start = prop.keyStart;
  let end = prop.valueEnd;

  // Absorb the separator so the remaining JSON stays valid.
  if (isLast && index > 0) {
    const previous = child.props[index - 1]!;
    start = previous.valueEnd;
    end = prop.valueEnd;
  } else {
    const after = skipTrivia(text, prop.valueEnd);
    if (text[after] === ',') end = after + 1;
  }

  return text.slice(0, start) + text.slice(end);
}

/** Read a root-level property value, or undefined. */
export function readRootProperty(text: string, name: string): unknown {
  const root = parseObjectAt(text, 0);
  const prop = root.props.find((candidate) => candidate.name === name);
  if (!prop) return undefined;
  return JSON.parse(stripJsonc(text.slice(prop.valueStart, prop.valueEnd)));
}

/** Validate that a JSONC blob parses after comment stripping. */
export function validateJsonc(text: string): { ok: boolean; error?: string } {
  try {
    JSON.parse(stripJsonc(text));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
