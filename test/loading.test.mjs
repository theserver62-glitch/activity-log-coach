import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { delayedDeviceMessage, WARMUP_MESSAGE } from '../src/loading.js';
import { appHarness, fakeClock } from './fixtures/ui.mjs';
import { localDate } from '../src/brief.js';

const reply = { today: 'Today result', avoid: 'Avoid result', meal: 'Meal result', why: 'Why result', inferenceSource: 'on_device' };

test('slow device message fires once at 1500 ms and abort/completion cancel it', () => {
  const runtime = fakeClock();
  const messages = [];
  const stop = delayedDeviceMessage(text => messages.push(text), { runtime });
  runtime.tick(1499);
  assert.deepEqual(messages, []);
  runtime.tick(1);
  assert.deepEqual(messages, [WARMUP_MESSAGE]);
  runtime.tick(10000);
  assert.equal(messages.length, 1);
  stop();
  for (const abort of [true, false]) {
    const controller = new AbortController();
    const cancel = delayedDeviceMessage(() => assert.fail('Stale message'), { runtime, signal: controller.signal });
    if (abort) controller.abort();
    else cancel();
    runtime.tick(1500);
    assert.equal(runtime.pending, 0);
  }
  const controller = new AbortController(); controller.abort();
  delayedDeviceMessage(() => assert.fail('Already aborted'), { runtime, signal: controller.signal });
  assert.equal(runtime.pending, 0);
});

test('page schedules warm-up from actual availability and renders the slow local loading line', async () => {
  const app = await appHarness();
  assert.deepEqual(app.warmups, ['available']);
  const request = app.submit();
  const result = app.get('#brief-result');
  assert.match(result.textContent, /Putting your day in perspective/);
  app.clock.tick(1499);
  assert.doesNotMatch(result.textContent, /Warming up/);
  app.clock.tick(1);
  assert.ok(result.textContent.includes(WARMUP_MESSAGE));
  assert.equal(result.attributes.get('aria-busy'), 'true');
  app.pending[0].resolve(reply);
  await request;
  assert.ok(result.textContent.includes(reply.today));
  assert.doesNotMatch(result.textContent, /Warming up/);
  assert.equal(result.attributes.has('aria-busy'), false);
  assert.equal(app.clock.pending, 0);
});

test('fast local success and failure both cancel the delayed loading line', async () => {
  for (const fail of [false, true]) {
    const app = await appHarness();
    const request = app.submit();
    app.clock.tick(1000);
    if (fail) app.pending[0].reject(new Error('Try again'));
    else app.pending[0].resolve(reply);
    await request;
    app.clock.tick(10000);
    assert.doesNotMatch(app.get('#brief-result').textContent, /Warming up/);
    assert.match(app.get('#brief-result').textContent, fail ? /Try again/ : /Today result/);
    assert.equal(app.clock.pending, 0);
  }
});

test('cloud-only generation never displays a local warm-up message', async () => {
  const app = await appHarness({ local: false });
  assert.deepEqual(app.warmups, ['downloadable']);
  const request = app.submit();
  app.clock.tick(12000);
  assert.match(app.get('#brief-result').textContent, /Putting your day in perspective/);
  assert.doesNotMatch(app.get('#brief-result').textContent, /Warming up/);
  app.pending[0].resolve({ ...reply, inferenceSource: 'in_cloud' });
  await request;
});

test('input changes and consent revocation abort old requests without stale timer updates', async () => {
  for (const selector of ['#check-in-form', '#allow-cloud']) {
    const app = await appHarness();
    const first = app.submit();
    app.clock.tick(1000);
    app.get(selector).fire(selector === '#allow-cloud' ? 'change' : 'input');
    assert.equal(app.pending[0].signal.aborted, true);
    assert.equal(app.clock.pending, 0);
    const second = app.submit();
    app.pending[0].resolve(reply);
    await first;
    app.clock.tick(500);
    assert.doesNotMatch(app.get('#brief-result').textContent, /Warming up|Today result/);
    app.clock.tick(1000);
    assert.ok(app.get('#brief-result').textContent.includes(WARMUP_MESSAGE));
    app.pending[1].resolve(reply);
    await second;
    assert.equal(app.clock.pending, 0);
  }
});

test('workout UI displays relative dates and humanizes dates embedded in titles', async () => {
  const reference = new Date();
  const logs = [0, 1, 2, 3].map(days => {
    const date = new Date(reference); date.setDate(date.getDate() - days);
    return { id: String(days), date: localDate(date), type: 'strength', bodyArea: 'legs', rpe: 9, minutes: 30, title: `Squats ${localDate(date)}` };
  });
  const app = await appHarness({ logs });
  const list = app.get('#workout-list');
  assert.doesNotMatch(list.textContent, /\d{4}-\d{2}-\d{2}/);
  for (const label of ['today', 'yesterday', '2 days ago']) assert.ok(list.textContent.includes(label));
  for (const item of list.children) assert.doesNotMatch(item.children.find(child => child.tagName === 'button').attributes.get('aria-label'), /\d{4}-\d{2}-\d{2}/);
});

test('loading animations remain disabled for prefers-reduced-motion', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation:\s*none\s*!important/);
});
