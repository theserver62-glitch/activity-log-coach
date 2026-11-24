// Real installed Firebase browser SDK, simulated Chrome model and HTTP boundary.
// No browser automation, model download, credentials or external requests.
import * as browserAI from '../../node_modules/@firebase/ai/dist/esm/index.esm.js';
import { initializeApp, getApps } from 'firebase/app';
import assert from 'node:assert/strict';
import { createAIService, BRIEF_SCHEMA } from '../../src/ai.js';

const content = JSON.stringify({ today: 'Walk for 20 minutes.', avoid: 'Hard legs after Monday RPE 9.', meal: 'Tofu rice bowl.', why: 'Low energy today.' });
let availability = 'available';
let networkAllowed = false;
let networkCalls = 0;
let localCalls = 0;
globalThis.LanguageModel = {
  availability: async () => availability,
  create: async () => ({
    prompt: async (messages, options) => {
      localCalls++;
      assert.deepEqual(options.responseConstraint, BRIEF_SCHEMA);
      assert.ok(JSON.stringify(messages).includes('Activity Log Coach'));
      return content;
    },
    destroy() {},
  }),
};
globalThis.window = { LanguageModel: globalThis.LanguageModel };
globalThis.fetch = async (url, options) => {
  assert.ok(networkAllowed, 'Unexpected network request without cloud consent');
  networkCalls++;
  assert.match(String(url), /firebasevertexai\.googleapis\.com/);
  const body = JSON.parse(options.body);
  assert.deepEqual(body.generationConfig.responseJsonSchema, BRIEF_SCHEMA);
  return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: content }] }, finishReason: 'STOP' }] }), { status: 200 });
};
const env = Object.fromEntries(['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'APP_ID', 'MESSAGING_SENDER_ID', 'STORAGE_BUCKET'].map(key => [`VITE_FIREBASE_${key}`, 'test-only']));
env.VITE_APPCHECK_SITE_KEY = 'test-only';
const service = createAIService({ env, sdk: {
  initializeApp, getApps,
  getAI: browserAI.getAI, getGenerativeModel: browserAI.getGenerativeModel,
  GoogleAIBackend: browserAI.GoogleAIBackend,
  // The real reCAPTCHA provider needs a real page and project; tested separately by stubs.
  initializeAppCheck: () => ({}), ReCaptchaEnterpriseProvider: class {},
} });
const request = { logs: [], checkIn: { sleep: 5, soreness: 7, energy: 'low', note: '' }, today: '2026-11-24' };
assert.equal((await service.generateBrief(request)).inferenceSource, 'on_device');
assert.equal(localCalls, 1);
assert.equal(networkCalls, 0);
availability = 'unavailable';
await assert.rejects(service.generateBrief(request), { code: 'device' });
assert.equal(networkCalls, 0);
networkAllowed = true;
assert.equal((await service.generateBrief({ ...request, allowCloud: true })).inferenceSource, 'in_cloud');
assert.equal(networkCalls, 1);
process.stdout.write('Real SDK: local routing, consent boundary, cloud schema and inferenceSource verified.\n');
