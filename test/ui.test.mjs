import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appHarness } from './fixtures/ui.mjs';
import { sampleWorkouts } from '../src/store.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const reply = { today: 'Walk for 20 minutes.', avoid: 'Hard legs today.', meal: 'Tofu rice bowl.', inferenceSource: 'on_device' };

// Only element structure is needed here. Handle quoted attributes and void tags,
// so radio inputs inside labels are checked alongside direct button siblings.
function parseElements(markup) {
  const root = { tagName: 'root', children: [], attributes: new Map() };
  const stack = [root];
  for (const match of markup.matchAll(/<\/?[a-z][^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/^<\/?([\w-]+)/)[1].toLowerCase();
    if (tag.startsWith('</')) {
      assert.equal(stack.pop().tagName, name, `Unbalanced closing tag: ${tag}`);
      continue;
    }
    const attributes = new Map([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(([, key, double, single, bare]) => [key, double ?? single ?? bare]));
    const node = { tagName: name, attributes, children: [] };
    stack.at(-1).children.push(node);
    if (!/\/>$/.test(tag) && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(name)) stack.push(node);
  }
  assert.equal(stack.length, 1, 'Unclosed HTML element');
  return root;
}
function* descendants(node) {
  yield node;
  for (const child of node.children) yield* descendants(child);
}
const attr = (node, key) => key === 'class' ? node.className ?? node.attributes.get(key) ?? '' : node.attributes.get(key);
const isChoice = node => node.tagName === 'button' || ['radio', 'tab'].includes(attr(node, 'role')) || (node.tagName === 'input' && attr(node, 'type') === 'radio');

function declarations(node, styles) {
  let result = '';
  for (const [, selectors, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const matches = selectors.split(',').some(selector => {
      const simple = selector.trim();
      return simple === node.tagName || simple === `#${attr(node, 'id')}`
        || (/^\.[\w-]+$/.test(simple) && attr(node, 'class').split(/\s+/).includes(simple.slice(1)));
    });
    if (matches) result += `;${body}`;
  }
  return result + ';' + (attr(node, 'style') ?? '');
}
function assertNoChoiceRows(root, styles = css) {
  for (const node of descendants(root)) {
    const choices = node.children.filter(child => isChoice(child)
      || (child.tagName === 'label' && [...descendants(child)].some(isChoice)));
    if (choices.length < 2) continue;
    const rules = declarations(node, styles);
    // A vertical action list is permitted; inline/flex rows and multi-column
    // grids are rejected, including when introduced inside a media query.
    const vertical = /flex-direction:\s*column\s*(?:;|$)/.test(rules)
      && !/flex-direction:\s*(?:row|row-reverse)\b/.test(rules);
    assert.ok(vertical, `Choice row found in ${node.tagName}.${attr(node, 'class')} (${choices.length} controls)`);
  }
}

test('no choice button rows in HTML or generated loading, result and error UI', async () => {
  assertNoChoiceRows(parseElements(html));
  const app = await appHarness({ logs: sampleWorkouts() });
  assertNoChoiceRows(app.get('#workout-list'));
  const request = app.submit();
  assertNoChoiceRows(app.get('#brief-result'));
  app.pending[0].resolve(reply);
  await request;
  assertNoChoiceRows(app.get('#brief-result'));
  const failure = app.submit();
  app.pending[1].reject(Object.assign(new Error('Download required'), { code: 'device' }));
  await failure;
  assert.equal([...descendants(app.get('#brief-result'))].filter(isChoice).length, 2);
  assertNoChoiceRows(app.get('#brief-result'));
});

test('choice-row guard catches buttons, ARIA radios/tabs and wrapped native radios', () => {
  for (const controls of [
    '<button>Low</button><button>High</button>',
    '<span role="radio">Low</span><span role="radio">High</span>',
    '<span role="tab">Low</span><span role="tab">High</span>',
    '<label><input type="radio" name="energy" />Low</label><label><input type="radio" name="energy" />High</label>',
  ]) {
    for (const layout of ['display: flex;', 'display: grid; grid-template-columns: repeat(2, 1fr);']) {
      assert.throws(() => assertNoChoiceRows(parseElements(`<div class="choices">${controls}</div>`), `.choices { ${layout} }`), /Choice row/);
    }
  }
});

test('energy, type and body area use a range or native select; sliders have three labels', () => {
  const nodes = [...descendants(parseElements(html))];
  for (const [name, tag, type] of [['energy', 'input', 'range'], ['type', 'select'], ['bodyArea', 'select']]) {
    const controls = nodes.filter(node => attr(node, 'name') === name);
    assert.equal(controls.length, 1, `${name} must have one control`);
    assert.equal(controls[0].tagName, tag);
    if (type) assert.equal(attr(controls[0], 'type'), type);
  }
  for (const [id, min, max, step] of [['energy', '0', '2', '1'], ['sleep', '3', '10', '0.5'], ['soreness', '0', '10', '1']]) {
    const control = nodes.find(node => attr(node, 'id') === id);
    assert.deepEqual(['type', 'min', 'max', 'step'].map(key => attr(control, key)), ['range', min, max, step]);
    const field = nodes.find(node => node.children.includes(control));
    assert.equal(field.children.find(node => attr(node, 'class').includes('range-labels')).children.length, 3);
    assert.ok(field.children.some(node => node.tagName === 'output' && attr(node, 'for') === id));
  }
});

test('slider inputs retain stored energy strings and update values and accessible text', async () => {
  for (const [index, energy] of ['low', 'okay', 'high'].entries()) {
    const app = await appHarness({ checkIn: { energy } });
    assert.equal(Number(app.get('#energy').value), index);
    assert.equal(app.state.checkIn.energy, energy);
    app.get('#energy').value = String((index + 1) % 3);
    app.get('#sleep').value = '6.5';
    app.get('#soreness').value = '8';
    app.get('#check-in-form').fire('input');
    const nextEnergy = ['low', 'okay', 'high'][(index + 1) % 3];
    assert.equal(app.state.checkIn.energy, nextEnergy);
    assert.equal(app.state.checkIn.sleep, 6.5);
    assert.equal(app.state.checkIn.soreness, 8);
    assert.equal(app.get('#energy-value').textContent.toLowerCase(), nextEnergy);
    assert.equal(app.get('#energy').attributes.get('aria-valuetext').toLowerCase(), nextEnergy);
    assert.equal(app.get('#sleep-value').textContent, '6.5 h');
    assert.equal(app.get('#sleep').attributes.get('aria-valuetext'), '6.5 hours');
    assert.equal(app.get('#soreness-value').textContent, '8/10');
    assert.equal(app.get('#soreness').attributes.get('aria-valuetext'), '8 out of 10');
  }
});

test('saved sleep values outside the new slider range normalize consistently', async () => {
  for (const [sleep, expected] of [[0, 3], [24, 10], [7.3, 7.5]]) {
    const app = await appHarness({ checkIn: { sleep } });
    assert.equal(Number(app.get('#sleep').value), expected);
    assert.equal(app.state.checkIn.sleep, expected);
  }
});

test('brief shows three labeled rows, source, recorder timing text and start chip lifecycle', async () => {
  for (const local of [true, false]) {
    const app = await appHarness({ local });
    assert.equal(app.get('#brief-start').hidden, false);
    const request = app.submit();
    assert.equal(app.get('#brief-start').hidden, true);
    app.pending[0].resolve({ ...reply, inferenceSource: local ? 'on_device' : 'in_cloud' });
    await request;
    const rows = app.get('#brief-result').children[0].children[0].children;
    assert.deepEqual(rows.map(row => row.children[0].textContent), ['Today', 'Avoid', 'Meal']);
    assert.deepEqual(rows.map(row => row.children[1].textContent), [reply.today, reply.avoid, reply.meal]);
    assert.equal(app.get('#source-badge').textContent, local ? '✓ On this device' : 'Cloud (Gemini)');
    assert.match(app.get('#generation-meta').textContent, local ? /^Made on this device · \d+\.\d s$/ : /^Made in the cloud \(Gemini\) · \d+\.\d s$/);
    assert.equal(app.get('#brief-start').hidden, true);
    app.get('#check-in-form').fire('input');
    assert.equal(app.get('#brief-start').hidden, false);
    assert.equal(app.get('#generation-meta').hidden, true);
  }
});

test('recorder names remain available and mobile document order places the brief after submit', () => {
  assert.match(html, /id="get-brief"[^>]*><span>Get today's brief<\/span>/);
  assert.match(html, /id="download-model"[^>]*>Download on-device model<\/button>/);
  assert.match(html, /aria-label="Allow cloud when on-device AI is unavailable"/);
  assert.match(html, /<span>Cloud fallback<\/span>/);
  assert.match(html, /Not medical advice\./);
  assert.match(html, /id="get-brief"[\s\S]*?<\/form>\s*<\/section>\s*<div class="result-column">\s*<section class="brief-section"/);
});
