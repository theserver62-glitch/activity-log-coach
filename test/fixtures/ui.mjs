import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as brief from '../../src/brief.js';
import { validWorkout, validCheckIn } from '../../src/store.js';
import { delayedDeviceMessage } from '../../src/loading.js';

export function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map();
  return {
    setTimeout(callback, ms) { const id = ++next; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
    get pending() { return timers.size; },
  };
}

class Node {
  children = [];
  listeners = new Map();
  attributes = new Map();
  value = '';
  text = '';
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  checkValidity() { return true; }
  focus() {}
  querySelectorAll() { return []; }
  fire(name, extra = {}) { return this.listeners.get(name)?.({ preventDefault() {}, target: this, currentTarget: this, ...extra }); }
}

export async function appHarness({ local = true, logs = [] } = {}) {
  const nodes = new Map();
  const get = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Node());
    return nodes.get(selector);
  };
  const clock = fakeClock();
  const warmups = [];
  const pending = [];
  const state = { logs, checkIn: { date: brief.localDate(), sleep: 7, soreness: 3, energy: 'okay', note: '' }, allowCloud: !local, notice: '' };
  const coachAI = {
    cloudConfigured: true,
    getDeviceStatus: async () => local ? 'available' : 'downloadable',
    scheduleDeviceWarmup: status => warmups.push(status),
    generateBrief: options => {
      if (local) options.onDeviceStart();
      return new Promise((resolve, reject) => pending.push({ resolve, reject, signal: options.signal }));
    },
  };
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  runInNewContext(main, {
    ...brief, coachAI, friendlyError: error => error.message, validWorkout, validCheckIn,
    delayedDeviceMessage: (onSlow, options) => delayedDeviceMessage(onSlow, { ...options, runtime: clock }),
    loadState: () => state, saveState: () => true,
    document: { querySelector: get, createElement: () => new Node(), querySelectorAll: () => [] },
    window: new Node(), navigator: { onLine: true }, AbortController, performance,
    FormData: class { get(key) { return state.checkIn[key]; } },
  }, { filename: 'src/main.js' });
  // Let the VM and host promise queues both finish the initial status refresh.
  await new Promise(resolve => setImmediate(resolve));
  return { get, clock, pending, warmups, state, submit: () => get('#check-in-form').fire('submit') };
}
