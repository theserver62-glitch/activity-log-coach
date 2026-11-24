import test from 'node:test';
import assert from 'node:assert/strict';
import { loadState, saveState, sampleWorkouts } from '../src/store.js';
import { recentWorkouts } from '../src/brief.js';

function memory(initial = null) {
  let value = initial;
  return { getItem: () => value, setItem: (key, next) => { value = next; } };
}
test('first run has three samples, off consent, and clear stays empty after reload', () => {
  const storage = memory();
  const state = loadState(storage);
  assert.equal(state.logs.length, 3);
  assert.ok(state.logs.every(log => log.sample));
  assert.equal(state.allowCloud, false);
  state.logs = []; state.allowCloud = true;
  assert.equal(saveState(state, storage), true);
  assert.equal(loadState(storage).logs.length, 0);
  assert.equal(loadState(storage).allowCloud, true);
});
test('samples use most recent Mon/Tue/Wed, stay within the last week and never in future', () => {
  const samples = sampleWorkouts(new Date('2026-11-24T12:00:00'));
  assert.deepEqual(samples.map(log => new Date(`${log.date}T12:00:00`).getDay()), [1, 2, 3]);
  assert.deepEqual(samples.map(log => log.rpe), [9, 4, 8]);
  assert.equal(recentWorkouts(samples, '2026-11-24').length, 3);
});
test('corrupt or blocked storage fails safely, without reseeding deleted samples', () => {
  assert.equal(loadState(memory('broken')).logs.length, 0);
  const blocked = { getItem() { throw new Error(); }, setItem() { throw new Error(); } };
  assert.ok(loadState(blocked).notice);
  assert.equal(saveState({ logs: [] }, blocked), false);
});
test('old check-in is reset and malformed consent is never treated as true', () => {
  const state = loadState(memory(JSON.stringify({ logs: [], allowCloud: 'true', checkIn: { date: '2020-01-01', sleep: 2, soreness: 10, energy: 'low', note: 'old' } })));
  assert.equal(state.checkIn.note, '');
  assert.equal(state.checkIn.sleep, 7);
  assert.equal(state.allowCloud, false);
});
