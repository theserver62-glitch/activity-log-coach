import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIService, BRIEF_SCHEMA, MODEL_OPTIONS, CLOUD_MODEL } from '../src/ai.js';

// Non-credential fixture values, used only by the SDK stub below.
const env = Object.fromEntries(['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'APP_ID', 'MESSAGING_SENDER_ID', 'STORAGE_BUCKET'].map(key => [`VITE_FIREBASE_${key}`, 'test-only']));
env.VITE_APPCHECK_SITE_KEY = 'test-only';
const output = JSON.stringify({ today: 'Walk, 20 minutes', avoid: 'Heavy legs after RPE 9 squats', meal: 'Tofu rice bowl', why: 'Low energy' });
const input = { logs: [], checkIn: { sleep: 5, soreness: 7, energy: 'low', note: '' }, today: '2026-11-24' };

function harness({ status = 'available', online = true, source = 'on_device', config = env, reply = output } = {}) {
  const calls = [];
  const runtime = {
    navigator: { onLine: online }, self: {},
    LanguageModel: {
      availability: async options => { calls.push(['availability', options]); return status; },
      create: async options => {
        calls.push(['create', options]);
        options.monitor?.({ addEventListener: (name, callback) => { assert.equal(name, 'downloadprogress'); callback({ loaded: .5 }); } });
        return { prompt: async (prompt, options) => { calls.push(['prompt', prompt, options]); return reply; }, destroy: () => calls.push(['destroy']) };
      },
    },
  };
  const sdk = {
    getApps: () => [],
    initializeApp: (options, settings) => { const app = { name: settings.name }; calls.push(['app', options, settings]); return app; },
    initializeAppCheck: (app, options) => { calls.push(['appcheck', options, app]); return {}; },
    ReCaptchaV3Provider: class {}, GoogleAIBackend: class {},
    getAI: app => { calls.push(['ai', app]); return {}; },
    getGenerativeModel: (ai, options) => {
      calls.push(['model', options]);
      return { generateContent: async (prompt, options) => { calls.push(['generate', prompt, options]); return { response: { text: () => reply, inferenceSource: source } }; } };
    },
  };
  return { service: createAIService({ env: config, runtime, sdk }), calls, runtime };
}

test('default off uses SDK ONLY_ON_DEVICE and never initializes App Check', async () => {
  const { service, calls } = harness();
  assert.equal((await service.generateBrief(input)).inferenceSource, 'on_device');
  assert.equal(calls.find(c => c[0] === 'model')[1].mode, 'only_on_device');
  assert.ok(!calls.some(c => c[0] === 'appcheck'));
});
test('consent + full config use PREFER_ON_DEVICE, App Check before AI, both schemas and actual source', async () => {
  const { service, calls } = harness({ status: 'unavailable', source: 'in_cloud' });
  const brief = await service.generateBrief({ ...input, allowCloud: true });
  assert.equal(brief.inferenceSource, 'in_cloud');
  const options = calls.find(c => c[0] === 'model')[1];
  assert.equal(options.mode, 'prefer_on_device');
  assert.equal(options.inCloudParams.model, CLOUD_MODEL);
  assert.deepEqual(options.inCloudParams.generationConfig.responseJsonSchema, BRIEF_SCHEMA);
  assert.deepEqual(options.onDeviceParams.promptOptions.responseConstraint, BRIEF_SCHEMA);
  assert.ok(calls.findIndex(c => c[0] === 'appcheck') < calls.findIndex(c => c[0] === 'ai'));
});
test('unavailable with consent off never calls Firebase', async () => {
  const { service, calls } = harness({ status: 'unavailable' });
  await assert.rejects(service.generateBrief(input), { code: 'device' });
  assert.deepEqual(calls.map(c => c[0]), ['availability']);
});
test('missing config stays ONLY_ON_DEVICE even with saved consent and works via native model', async () => {
  const { service, calls } = harness({ config: {} });
  assert.equal(service.cloudConfigured, false);
  assert.equal(service.inferenceMode(true), 'only_on_device');
  assert.equal((await service.generateBrief({ ...input, allowCloud: true })).inferenceSource, 'on_device');
  assert.ok(!calls.some(c => ['app', 'ai', 'model', 'appcheck'].includes(c[0])));
  assert.deepEqual(calls.find(c => c[0] === 'prompt')[2].responseConstraint, BRIEF_SCHEMA);
  assert.ok(calls.some(c => c[0] === 'destroy'));
});
test('missing App Check key disables fallback but keeps configured SDK local inference', async () => {
  const { service, calls } = harness({ config: { ...env, VITE_APPCHECK_SITE_KEY: '' } });
  await service.generateBrief({ ...input, allowCloud: true });
  assert.equal(calls.find(c => c[0] === 'model')[1].mode, 'only_on_device');
});
test('offline forces local inference; absent model explains offline without network', async () => {
  const local = harness({ online: false });
  await local.service.generateBrief({ ...input, allowCloud: true });
  assert.equal(local.calls.find(c => c[0] === 'model')[1].mode, 'only_on_device');
  const missing = harness({ online: false, status: 'unavailable' });
  await assert.rejects(missing.service.generateBrief({ ...input, allowCloud: true }), { code: 'offline' });
  assert.ok(!missing.calls.some(c => c[0] === 'app'));
});
test('download starts create synchronously from click and reports progress, then releases session', async () => {
  const { service, calls } = harness();
  const progress = [];
  const pending = service.downloadDeviceModel(value => progress.push(value));
  assert.equal(calls[0][0], 'create');
  assert.deepEqual(calls[0][1].expectedInputs, MODEL_OPTIONS.expectedInputs);
  await pending;
  assert.deepEqual(progress, [.5, 1]);
  assert.ok(calls.some(c => c[0] === 'destroy'));
});
test('debug token requires DEV and explicit opt-in; never enabled in production', async () => {
  for (const dev of [true, false]) {
    const { service, runtime } = harness({ config: { ...env, DEV: dev, VITE_APPCHECK_DEBUG_TOKEN: 'true' } });
    await service.generateBrief({ ...input, allowCloud: true });
    assert.equal(runtime.self.FIREBASE_APPCHECK_DEBUG_TOKEN, dev ? true : undefined);
  }
});
test('revoking consent changes the next call to ONLY_ON_DEVICE', async () => {
  const { service, calls } = harness();
  await service.generateBrief({ ...input, allowCloud: true });
  await service.generateBrief({ ...input, allowCloud: false });
  assert.deepEqual(calls.filter(c => c[0] === 'model').map(c => c[1].mode), ['prefer_on_device', 'only_on_device']);
});
test('enabling cloud after a local request initializes a fresh App Check-protected AI service', async () => {
  const { service, calls } = harness();
  await service.generateBrief({ ...input, allowCloud: false });
  await service.generateBrief({ ...input, allowCloud: true });
  const aiCalls = calls.filter(c => c[0] === 'ai');
  assert.notEqual(aiCalls[0][1].name, aiCalls[1][1].name);
  const appCheckCall = calls.find(c => c[0] === 'appcheck');
  assert.equal(appCheckCall[2], aiCalls[1][1]);
  assert.ok(calls.indexOf(appCheckCall) < calls.indexOf(aiCalls[1]));
});
test('aborted request does not start inference and unreported source is rejected', async () => {
  const { service, calls } = harness();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.generateBrief({ ...input, signal: controller.signal }), { name: 'AbortError' });
  assert.ok(!calls.some(c => c[0] === 'model'));
  await assert.rejects(harness({ source: 'unknown' }).service.generateBrief(input), { code: 'source' });
});

test('native, SDK local and cloud replies all pass the same recovery guard', async () => {
  const reply = JSON.stringify({ today: 'Rest, 0 minutes', avoid: 'Avoid upper push from Nov 18.', why: 'You are exhausted.', meal: 'Tofu rice bowl' });
  for (const options of [{ config: {} }, {}, { status: 'unavailable', source: 'in_cloud' }]) {
    const { service, calls } = harness({ ...options, reply });
    const result = await service.generateBrief({ ...input, allowCloud: true, logs: [{ date: '2026-11-23', bodyArea: 'legs', type: 'strength', rpe: 9, minutes: 50 }], checkIn: { sleep: 7, soreness: 3, energy: 'okay', note: '' } });
    assert.match(result.today, /upper push.*20-40 min, RPE 4-6/);
    assert.match(result.avoid, /legs.*RPE 9 yesterday/);
    assert.doesNotMatch(result.why, /exhausted/);
    assert.equal(result.adjusted, true);
    assert.equal(result.inferenceSource, options.source ?? 'on_device');
    assert.match(calls.find(call => ['generate', 'prompt'].includes(call[0]))[1], /Coach rules \(must follow\)/);
  }
});

test('warm-up creates and destroys exactly one local session in idle time per page', async () => {
  const { service, calls, runtime } = harness();
  const idle = [];
  runtime.requestIdleCallback = callback => idle.push(callback);
  const status = await service.getDeviceStatus();
  service.scheduleDeviceWarmup(status);
  service.scheduleDeviceWarmup(status);
  createAIService({ env: {}, runtime }).scheduleDeviceWarmup(status);
  assert.equal(idle.length, 1);
  assert.deepEqual(calls.map(call => call[0]), ['availability']);
  await idle[0]();
  assert.deepEqual(calls.map(call => call[0]), ['availability', 'availability', 'create', 'destroy']);
  assert.deepEqual(calls.find(call => call[0] === 'create')[1], MODEL_OPTIONS);
  service.scheduleDeviceWarmup('available');
  assert.equal(idle.length, 1);
});

test('warm-up falls back to a 1500 ms timeout without requestIdleCallback', async () => {
  const { service, calls, runtime } = harness({ config: {} });
  const pending = [];
  runtime.setTimeout = (callback, ms) => pending.push({ callback, ms });
  service.scheduleDeviceWarmup(await service.getDeviceStatus());
  assert.equal(pending[0].ms, 1500);
  assert.ok(!calls.some(call => call[0] === 'create'));
  await pending[0].callback();
  assert.deepEqual(calls.slice(-2).map(call => call[0]), ['create', 'destroy']);
});

test('warm-up never schedules or creates for downloadable, downloading or unavailable models', async () => {
  for (const status of ['downloadable', 'downloading', 'unavailable']) {
    const { service, runtime, calls } = harness({ status });
    runtime.requestIdleCallback = () => assert.fail('Must not schedule a download');
    runtime.setTimeout = () => assert.fail('Must not schedule a download');
    service.scheduleDeviceWarmup(await service.getDeviceStatus());
    assert.deepEqual(calls.map(call => call[0]), ['availability']);
  }
});

test('warm-up rechecks availability at idle time without starting a download', async () => {
  for (const status of ['downloadable', 'downloading', 'unavailable']) {
    const { service, runtime, calls } = harness();
    let idle;
    runtime.requestIdleCallback = callback => { idle = callback; };
    service.scheduleDeviceWarmup(await service.getDeviceStatus());
    runtime.LanguageModel.availability = async () => status;
    await idle();
    assert.ok(!calls.some(call => call[0] === 'create'));
  }
});

test('warm-up ignores availability, create, destroy and scheduling errors', async () => {
  for (const step of ['availability', 'create', 'destroy', 'schedule']) {
    const { service, runtime } = harness();
    let idle;
    runtime.requestIdleCallback = callback => { if (step === 'schedule') throw new Error('scheduler'); idle = callback; };
    if (step === 'availability') runtime.LanguageModel.availability = async () => { throw new Error('availability'); };
    if (step === 'create') runtime.LanguageModel.create = async () => { throw new Error('create'); };
    if (step === 'destroy') runtime.LanguageModel.create = async () => ({ destroy: () => { throw new Error('destroy'); } });
    assert.doesNotThrow(() => service.scheduleDeviceWarmup('available'));
    if (idle) await assert.doesNotReject(idle());
  }
});

test('generation announces local start before native or SDK work, never for cloud-only work', async () => {
  for (const options of [{ config: {} }, {}, { status: 'unavailable', source: 'in_cloud' }, { status: 'downloadable', source: 'in_cloud' }]) {
    const { service, calls } = harness(options);
    await service.generateBrief({ ...input, allowCloud: true, onDeviceStart: () => calls.push(['local-start']) });
    const start = calls.findIndex(call => call[0] === 'local-start');
    if (options.source === 'in_cloud') assert.equal(start, -1);
    else assert.ok(start >= 0 && start < calls.findIndex(call => ['create', 'model'].includes(call[0])));
  }
  const { service } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.generateBrief({ ...input, signal: controller.signal, onDeviceStart: () => assert.fail('Aborted') }), { name: 'AbortError' });
});

test('native, SDK and cloud preserve valid Today variety, tidy Meal, and human dates', async () => {
  const todayLine = '30 min easy upper-body push: push-ups and light dumbbell press, RPE 5.';
  const reply = JSON.stringify({ today: todayLine, avoid: 'bad', why: 'bad', meal: 'How about a yummy lentil soup sounds great!' });
  for (const options of [{ config: {} }, {}, { status: 'unavailable', source: 'in_cloud' }]) {
    const { service } = harness({ ...options, reply });
    const result = await service.generateBrief({ ...input, allowCloud: true, logs: [{ date: '2026-11-23', bodyArea: 'legs', title: 'squats', rpe: 9 }], checkIn: { sleep: 7, soreness: 3, energy: 'okay', note: '' } });
    assert.equal(result.today, todayLine);
    assert.equal(result.meal, 'Lentil soup.');
    assert.equal(result.avoid, 'Skip hard legs — squats at RPE 9 yesterday.');
  }
  assert.equal(BRIEF_SCHEMA.properties.meal.maxLength, 99);
});
