import test from 'node:test';
import assert from 'node:assert/strict';

const base = new URL('../dist/', import.meta.url);
const { buildElementorData, deepMerge, ensureIds, findWidgets, summarizeElementorData, elementId } =
  await import(new URL('wp/elementor.js', base).href);

const SPEC = {
  sections: [
    {
      settings: { layout: 'boxed', gap: 'extended' },
      columns: [
        {
          size: 58,
          settings: { _column_size: 58 },
          widgets: [
            { type: 'heading', settings: { title: 'Hero', header_size: 'h1' } },
            { type: 'button', settings: { text: 'Go', link: { url: 'https://example.com' } } },
          ],
        },
        { size: 42, widgets: [{ type: 'text-editor', settings: { editor: '<p>body</p>' } }] },
      ],
    },
  ],
};

test('ids are 7 lowercase hex characters', () => {
  for (let i = 0; i < 50; i += 1) {
    const id = elementId();
    assert.equal(id.length, 7);
    assert.match(id, /^[0-9a-f]{7}$/);
  }
});

test('build creates section -> column -> widget tree', () => {
  const tree = buildElementorData(SPEC);
  assert.equal(tree.length, 1);

  const section = tree[0];
  assert.equal(section.elType, 'section');
  assert.equal(section.elements.length, 2);
  assert.equal(section.settings.layout, 'boxed');

  const column = section.elements[0];
  assert.equal(column.elType, 'column');
  assert.equal(column.elements.length, 2);
  assert.equal(column.settings._column_size, 58);
  assert.equal(column.settings._inline_size, 58);

  const heading = column.elements[0];
  assert.equal(heading.widgetType, 'heading');
  assert.equal(heading.settings.title, 'Hero');
  assert.ok(heading.id);
});

test('nested child widgets are supported', () => {
  const tree = buildElementorData({
    sections: [
      {
        columns: [
          {
            widgets: [
              {
                type: 'inner-section',
                settings: {},
                sections: [
                  { columns: [{ widgets: [{ type: 'heading', settings: { title: 'nested' } }] }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const nested = tree[0].elements[0].elements[0];
  assert.equal(nested.elType, 'widget');
  assert.equal(nested.widgetType, 'inner-section');
  assert.equal(nested.elements[0].elType, 'section');
  assert.equal(nested.elements[0].elements[0].elements[0].widgetType, 'heading');
});

test('container layout produces a container node', () => {
  const tree = buildElementorData({ layout: 'container', sections: [{ columns: [] }] });
  assert.equal(tree[0].elType, 'container');
});

test('all ids in a built tree are unique', () => {
  const tree = buildElementorData(SPEC);
  const ids = [];
  const walk = (node) => {
    ids.push(node.id);
    (node.elements ?? []).forEach(walk);
  };
  tree.forEach(walk);
  assert.equal(new Set(ids).size, ids.length);
});

test('summarize describes the tree instead of dumping it', () => {
  const summary = summarizeElementorData(buildElementorData(SPEC));
  assert.equal(summary.length, 1);
  const section = summary[0];
  assert.equal(section.elType, 'section');
  assert.equal(section.children.length, 2);

  const column = section.children[0];
  assert.equal(column.elType, 'column');
  assert.equal(column.children.length, 2);
  assert.equal(column.children[0].widgetType, 'heading');
  assert.equal(column.children[1].widgetType, 'button');
  // deep settings are omitted below depth 0 to keep the payload small
  assert.equal(column.children[0].settings, undefined);
});

test('findWidgets filters by type and path', () => {
  const tree = buildElementorData(SPEC);
  const buttons = findWidgets(tree, 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].path, '0/0/1');
  assert.equal(findWidgets(tree).length, 3);
});

test('ensureIds repairs duplicate and missing ids', () => {
  const data = buildElementorData(SPEC);
  data[0].elements[0].id = data[0].id;
  data[0].elements[1].id = '';
  ensureIds(data);
  const ids = [];
  const walk = (node) => {
    ids.push(node.id);
    node.elements.forEach(walk);
  };
  data.forEach(walk);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[0-9a-f]{7}$/.test(id)));
});

test('deepMerge merges nested settings and replaces arrays', () => {
  const base = {
    typography_typography: 'custom',
    typography_font_size: { unit: 'px', size: 16 },
    background_background: 'classic',
    list: [1, 2],
    keep: true,
  };
  const merged = deepMerge(base, {
    typography_font_size: { size: 22 },
    list: [3],
    added: 'x',
    keep: undefined,
  });

  assert.deepEqual(merged.typography_font_size, { unit: 'px', size: 22 });
  assert.equal(merged.typography_typography, 'custom');
  assert.deepEqual(merged.list, [3]);
  assert.equal(merged.added, 'x');
  assert.equal(merged.keep, true);
  // the original object is not mutated
  assert.deepEqual(base.typography_font_size, { unit: 'px', size: 16 });
});

test('deepMerge tolerates non-object patches', () => {
  const base = { a: 1 };
  assert.deepEqual(deepMerge(base, null), base);
  assert.deepEqual(deepMerge(base, 'nope'), base);
  assert.deepEqual(deepMerge(base, [1, 2]), base);
});
