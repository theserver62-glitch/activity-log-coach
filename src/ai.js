import { initializeApp, getApps } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource } from 'firebase/ai';
import { buildPrompt, parseBrief, recoveryFacts, MEAL_LIMIT } from './brief.js';

// Current Firebase hybrid docs and this installed SDK's default cloud model:
// https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options
export const CLOUD_MODEL = 'gemini-3.5-flash-lite';
export const MODEL_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
export const BRIEF_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(['today', 'avoid', 'meal', 'why'].map(key => [key, { type: 'string', minLength: 1, maxLength: key === 'meal' ? MEAL_LIMIT : 160 }])),
  required: ['today', 'avoid', 'meal', 'why'],
};

export class CoachError extends Error {
  constructor(code, message) { super(message); this.name = 'CoachError'; this.code = code; }
}

const firebaseSDK = { initializeApp, getApps, initializeAppCheck, ReCaptchaEnterpriseProvider, getAI, getGenerativeModel, GoogleAIBackend };
const warmupScheduled = new WeakSet();

// Injection keeps the consent/network boundary testable without network or credentials.
export function createAIService({ env = import.meta.env ?? {}, runtime = globalThis, sdk = firebaseSDK } = {}) {
  const config = {
    apiKey: env.VITE_FIREBASE_API_KEY?.trim(), authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
    projectId: env.VITE_FIREBASE_PROJECT_ID?.trim(), appId: env.VITE_FIREBASE_APP_ID?.trim(),
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(), storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET?.trim(),
  };
  const hasFirebaseConfig = Object.values(config).every(Boolean);
  const cloudConfigured = hasFirebaseConfig && Boolean(env.VITE_APPCHECK_SITE_KEY?.trim());
  const apps = new Map();
  let appCheck;

  function getFirebaseAI(useCloud) {
    // AIService captures App Check at its first initialization in SDK 3.1.0.
    // Separate app instances prevent an earlier local request from caching an
    // AI service without App Check when the user later enables cloud fallback.
    const name = useCloud ? 'activity-log-coach-cloud' : 'activity-log-coach-local';
    if (!apps.has(name)) {
      apps.set(name, sdk.getApps().find(item => item.name === name)
        ?? sdk.initializeApp(config, { name, automaticDataCollectionEnabled: false }));
    }
    const app = apps.get(name);
    if (useCloud && !appCheck) {
      // DEV is a Vite build-time flag. Production can never enable the debug provider.
      if (env.DEV) {
        const debugToken = env.VITE_APPCHECK_DEBUG_TOKEN?.trim();
        if (debugToken === 'true') runtime.self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
        else if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(debugToken ?? '')) {
          runtime.self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
        }
      }
      appCheck = sdk.initializeAppCheck(app, {
        provider: new sdk.ReCaptchaEnterpriseProvider(env.VITE_APPCHECK_SITE_KEY.trim()),
        // Fetch tokens on demand; don't keep refreshing after consent is revoked.
        isTokenAutoRefreshEnabled: false,
      });
    }
    return sdk.getAI(app, { backend: new sdk.GoogleAIBackend() });
  }

  async function getDeviceStatus() {
    try {
      const value = await runtime.LanguageModel?.availability(MODEL_OPTIONS);
      return ['available', 'downloadable', 'downloading', 'unavailable'].includes(value) ? value : 'unavailable';
    } catch { return 'unavailable'; }
  }

  function scheduleDeviceWarmup(status) {
    if (status !== 'available' || warmupScheduled.has(runtime)) return;
    warmupScheduled.add(runtime);
    const warm = async () => {
      try {
        // Availability may change between page load and the idle callback.
        if (await getDeviceStatus() !== 'available') return;
        const session = await runtime.LanguageModel.create(MODEL_OPTIONS);
        await session.destroy();
      } catch { /* Best effort only; never block the page or request a download. */ }
    };
    try {
      if (runtime.requestIdleCallback) runtime.requestIdleCallback(warm);
      else runtime.setTimeout(warm, 1500);
    } catch { /* Ignore unsupported scheduling APIs too. */ }
  }

  // Called directly from a click. Start create() before any await to retain activation.
  async function downloadDeviceModel(onProgress = () => {}) {
    if (!runtime.LanguageModel?.create) throw new CoachError('device', 'On-device AI is unavailable in this browser.');
    const session = await runtime.LanguageModel.create({
      ...MODEL_OPTIONS,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', event => onProgress(Math.max(0, Math.min(1, event.loaded))));
      },
    });
    session.destroy();
    onProgress(1);
    return getDeviceStatus();
  }

  function inferenceMode(allowCloud, online = runtime.navigator?.onLine !== false) {
    return allowCloud && cloudConfigured && online ? InferenceMode.PREFER_ON_DEVICE : InferenceMode.ONLY_ON_DEVICE;
  }

  async function generateBrief({ logs, checkIn, today, allowCloud = false, signal, onDeviceStart = () => {} }) {
    const mode = inferenceMode(allowCloud);
    const useCloud = mode === InferenceMode.PREFER_ON_DEVICE;
    const status = await getDeviceStatus();
    signal?.throwIfAborted();
    if (status !== 'available' && !useCloud) {
      if (runtime.navigator?.onLine === false) {
        throw new CoachError('offline', 'You’re offline and the on-device model is not ready. Reconnect to download it or use cloud AI.');
      }
      if (status === 'downloadable' || status === 'downloading') {
        throw new CoachError('download', 'Download the on-device model below, then try your brief again. Cloud AI is used only with your permission.');
      }
      throw new CoachError('device', 'On-device AI is unavailable in this browser. You can allow cloud AI to get your brief.');
    }
    const facts = recoveryFacts(logs, checkIn, today);
    const prompt = buildPrompt(logs, checkIn, today);
    if (status === 'available') onDeviceStart();
    let response;
    if (!hasFirebaseConfig) {
      // @firebase/ai 3.1.0 validates apiKey/projectId/appId even in ONLY_ON_DEVICE.
      // Use Chrome's same local engine in this mode instead of inventing credentials.
      // This branch has no Firebase initialization or network fallback.
      const session = await runtime.LanguageModel.create({ ...MODEL_OPTIONS, signal });
      try {
        const text = await session.prompt(prompt, { responseConstraint: BRIEF_SCHEMA, signal });
        response = { text: () => text, inferenceSource: InferenceSource.ON_DEVICE };
      } finally { session.destroy(); }
    } else {
      const ai = getFirebaseAI(useCloud);
      const model = sdk.getGenerativeModel(ai, {
        mode,
        onDeviceParams: { createOptions: { ...MODEL_OPTIONS, signal }, promptOptions: { responseConstraint: BRIEF_SCHEMA } },
        inCloudParams: {
          model: CLOUD_MODEL,
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: BRIEF_SCHEMA, maxOutputTokens: 1024 },
        },
      });
      ({ response } = await model.generateContent(prompt, { signal }));
    }
    signal?.throwIfAborted();
    const source = response.inferenceSource;
    if (source !== InferenceSource.ON_DEVICE && source !== InferenceSource.IN_CLOUD) {
      throw new CoachError('source', 'The AI did not report where this brief was made. Please try again.');
    }
    return { ...parseBrief(response.text(), facts, today), inferenceSource: source };
  }

  return { cloudConfigured, getDeviceStatus, scheduleDeviceWarmup, downloadDeviceModel, inferenceMode, generateBrief };
}

export const coachAI = createAIService();

export function friendlyError(error) {
  if (error instanceof CoachError) return error.message;
  if (/parse|incomplete|readable/i.test(error?.message ?? '')) return 'The AI returned an incomplete brief. Please try again.';
  if (/429|quota|resource-exhausted/i.test(`${error?.code} ${error?.message}`)) return 'Cloud AI is busy or its quota is used up. Try again later, or use on-device AI.';
  if (/app.?check|403|401|api.key|permission/i.test(`${error?.code} ${error?.message}`)) return 'Cloud AI could not connect. Check the Firebase and App Check setup, then retry.';
  return 'Your brief could not be created. Check the on-device model or your connection, then try again.';
}
