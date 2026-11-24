import test from 'node:test';
import assert from 'node:assert/strict';
import { loadState, saveState, sampleWorkouts } from '../src/store.js';
import { recentWorkouts, recoveryFacts } from '../src/brief.js';

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
test('samples are push three days ago, easy run two days ago and heavy legs yesterday', () => {
  const samples = sampleWorkouts(new Date('2026-11-24T12:00:00'));
  assert.deepEqual(samples.map(log => log.date), ['2026-11-21', '2026-11-22', '2026-11-23']);
  assert.deepEqual(samples.map(log => log.bodyArea), ['upper push', 'cardio', 'legs']);
  assert.deepEqual(samples.map(log => log.minutes), [45, 30, 50]);
  assert.deepEqual(samples.map(log => log.rpe), [8, 4, 9]);
  assert.equal(recentWorkouts(samples, '2026-11-24').length, 3);
  assert.deepEqual(recoveryFacts(samples, { sleep: 7, soreness: 3, energy: 'okay' }, '2026-11-24').avoidAreas, [{ area: 'legs', date: '2026-11-23', rpe: 9 }]);
});
test('relative samples cross year boundaries and do not change the supplied date', () => {
  const today = new Date('2027-01-01T12:00:00');
  const before = today.getTime();
  assert.deepEqual(sampleWorkouts(today).map(log => log.date), ['2026-12-29', '2026-12-30', '2026-12-31']);
  assert.equal(today.getTime(), before);
});
test('saved v1 and v2 samples refresh relative to today without restoring deleted samples or changing real logs', () => {
  const old = sampleWorkouts(new Date('2020-01-01T12:00:00'));
  const own = { ...old[0], id: 'own-workout', sample: false };
  const stored = [{ ...old[2], id: 'sample-mon' }, old[1], own];
  const state = loadState(memory(JSON.stringify({ logs: stored, allowCloud: false })));
  const current = sampleWorkouts();
  assert.deepEqual(state.logs, [current[2], current[1], own]);
  assert.ok(!state.logs.some(log => log.id === 'sample-push'));
  assert.equal(state.notice, '');
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
