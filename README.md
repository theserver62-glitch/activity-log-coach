# Activity Log Coach

An English, single-screen web app for Google's **#BuildHybridAI** hackathon. Recent workouts and today's check-in become a short, practical brief. Built with vanilla JavaScript, Vite 8 and Firebase 13. No accounts or analytics.

## What it does

- Log strength, runs, rides, swims, yoga or other workouts with body area, minutes, RPE and date. Delete individual entries.
- Start with clearly labeled sample workouts relative to today: upper-body push / bench press three days ago (45 min, RPE 8), easy run two days ago (30 min, RPE 4), and heavy squats 5×5 yesterday (50 min, RPE 9). Saved samples, including v1 samples, refresh to these relative dates on reload. **Clear samples** preserves your own entries; deleted samples stay deleted.
- Check in with sleep hours, soreness, energy and an optional 140-character note. Today's check-in is saved locally and resets on a new day's page load.
- Get **Today** (one workout and minutes), **Avoid** (what to skip and log-based reasoning), and **Meal** (one simple idea), plus a short explanation. Recovery facts determine the plan before inference. The source indicator reports **On this device** or **Generated in the cloud (Gemini)**, and a quiet line shows elapsed generation time measured with `performance.now()`.
- At 1100px and wider, workouts, check-in and the brief sit side by side. Tablet layouts use two columns; mobile uses one, with the brief following the check-in and its button. Only the brief has a white surface.
- Includes empty, loading, retry, offline, model download and storage failure states. Keyboard-accessible controls, visible focus, live announcements, light mode and reduced-motion support.

Workouts, check-in and cloud preference use only `localStorage`, under `activity-log-coach.v1`. Briefs stay in memory. Nothing is stored in Firestore or sent to analytics. Device storage is not encrypted and is shared by people using the same browser profile. The brief is **not medical advice**.

## Why hybrid

**Privacy:** Cloud fallback starts off. On-device inference keeps the prompt local. With the toggle on, the last seven calendar days of workouts and today's check-in, including the optional note, may be sent to Google Gemini when local inference is unavailable. Disabling the toggle aborts the active request and enforces local-only mode for subsequent requests; it cannot retract a request already sent.

**Offline:** A downloaded model can generate briefs in an already open app without a connection. Logging continues offline. The app does not cache the app shell for a cold offline visit or reload; first open the app while its server is reachable and download the model. Missing local models are explained rather than silently sending data to the cloud.

**Cost:** Local requests avoid cloud inference usage. Cloud requests use the small Flash-Lite fallback and a compact prompt. Any project quotas or billing still apply to cloud requests.

## How Firebase AI Logic is used

See [`src/ai.js`](src/ai.js):

- `createAIService()` reads `import.meta.env.VITE_FIREBASE_*`; no deployed keys or project credentials are committed.
- `getFirebaseAI()` lazily calls `initializeApp()`, initializes App Check before cloud use, and calls `getAI(app, { backend: new GoogleAIBackend() })`. Automatic Firebase data collection is disabled.
- `inferenceMode()` selects `InferenceMode.PREFER_ON_DEVICE` only when cloud consent, complete configuration and connectivity are present. Otherwise it selects `InferenceMode.ONLY_ON_DEVICE`.
- `generateBrief()` calls `getGenerativeModel(ai, { mode, onDeviceParams, inCloudParams })` and `model.generateContent()`. The cloud model is **`gemini-3.5-flash-lite`**, the current default documented in [Firebase's hybrid configuration guide](https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options) and in this SDK's implementation. The UI uses **`response.inferenceSource`**, comparing the SDK's `on_device` / `in_cloud` values; it does not guess based on the toggle.
- `onDeviceParams.promptOptions.responseConstraint` carries a JSON schema. Cloud `generationConfig` supplies `responseMimeType: 'application/json'` and the SDK-supported `responseJsonSchema`. See [hybrid structured output](https://firebase.google.com/docs/ai-logic/hybrid/web/generate-structured-output) and `node_modules/@firebase/ai/dist/ai-public.d.ts` (`GenerationConfig`, `HybridParams`, `OnDeviceParams`, `InferenceMode`, `InferenceSource`).
- `getDeviceStatus()` calls `LanguageModel.availability()` using English text-only input/output options. When available, one idle warm-up per page creates and destroys a local session (`requestIdleCallback`, or a 1500 ms timeout). It rechecks availability before creating, skips downloadable/downloading models and ignores errors. `downloadDeviceModel()` still starts only from a click, observes `downloadprogress` (`loaded` is 0–1), and destroys its temporary session afterward. Subsequent configured inference still uses Firebase AI Logic. Local brief generation lasting 1.5 seconds shows a quiet first-run wait message; completion, failure and cancellation clear its timer. Existing reduced-motion styles remain in effect.
- `recoveryFacts()`, `buildPrompt()`, `parseBrief()` and `checkBrief()` in [`src/brief.js`](src/brief.js) are pure functions. The recovery window is **today and yesterday**, since logs have dates rather than timestamps. RPE 8+ sessions flag their body areas (including hard cardio); easy runs never flag an area. Sleep under 6 hours, soreness 7+ or low energy means low readiness; high readiness requires sleep 7+, soreness at most 3, high energy and no flagged areas. All other cases are moderate.
- Prompts put **Coach rules (must follow)** above the last seven days of data. Code supplies intensity, fresh areas and approved fallback wording. Today can name 1–2 concrete exercises from a list for the suggested area, using a bounded sentence format. `checkBrief()` checks the entire sentence, minutes, intensity, optional RPE and exercise choices; invalid or conflicting text falls back to the deterministic plan. High readiness retains v2's 30-minute default. Avoid and Why remain approved-only, and adjusted plans are identified in the UI. Recovery thresholds and cloud consent rules are unchanged.
- Displayed dates and dates supplied to the model use “today”, “yesterday”, “2 days ago”, or a label such as “Sat, Nov 21”. Avoid cites the selected workout title when present; long titles shorten to preserve all flagged areas, RPE and dates within 160 characters. Stored dates retain their calendar format.
- Notes are capped, sanitized and delimited as untrusted data; they cannot override recovery rules. The parser handles JSON, fenced JSON and labeled lines and rejects incomplete garbage. Fields are capped at 160 characters; Meal is under 100. The Meal prompt requests a plain noun phrase plus a short reason, and `tidyMeal()` strips conversational filler from real Nano-style replies. Output is rendered as text, never HTML. A check-in can produce a brief without any workout history.

### SDK limitation when Firebase configuration is absent

The installed `@firebase/ai` **3.1.0** calls `initApiSettings()` from `AIModel` and rejects empty `apiKey`, `projectId` or `appId`, **even for `ONLY_ON_DEVICE`**. This is verified in `node_modules/@firebase/ai/dist/esm/index.esm.js`; it is not solved by a different inference enum.

To keep zero-config local inference working without fabricated keys, `generateBrief()` retains the `ONLY_ON_DEVICE` policy but uses the same Chrome `LanguageModel` directly when the Firebase web config is incomplete. That branch cannot initialize Firebase or call the cloud. Its known local response is tagged `InferenceSource.ON_DEVICE`. **It is a native local compatibility path, not an SDK inference call.** With complete Firebase web config, even consent-off local inference uses the Firebase SDK. If only the App Check site key is missing, cloud stays disabled and Firebase local inference still works. The app displays **Cloud fallback not configured**.

App Check is deliberately initialized only when a user has allowed cloud AI and a cloud-capable request begins. Separate named local/cloud Firebase app instances ensure that enabling cloud after a local request cannot reuse an AI service that captured an absent App Check provider. This avoids loading reCAPTCHA for local-only users. Tokens refresh on demand, not in the background. The optional debug provider is enabled only when Vite's `import.meta.env.DEV` is true and `VITE_APPCHECK_DEBUG_TOKEN=true`; it sets `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true`. Production ignores that setting.

## Run locally

Use **Node.js 24.12+**. Dependencies are already installed in this workspace; no install or network access is required to build or test.

```sh
npm run dev
```

Open the printed localhost URL (normally `http://127.0.0.1:5173`). The app renders with no `.env`. To use local AI, the browser still needs a supported, downloaded model.

```sh
npm test
npm run build
npm run preview
```

On Windows PowerShell with blocked `.ps1` scripts, use `npm.cmd test`, `npm.cmd run build`, and `npm.cmd run dev` (or run the same `npm` commands from Command Prompt). This does not require changing execution policy. `test/index.js` lets the requested `node --test test/` script resolve the suite on Windows Node 24.

## Configure Firebase

1. Create/select a Firebase project and register a web app. In **Firebase AI Logic**, complete setup for the **Gemini Developer API** / Google AI backend. Do not embed a separate Gemini Developer API secret in this app. See the [Firebase hybrid getting-started guide](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started).
2. Register your web app with **Firebase App Check**, using **reCAPTCHA Enterprise (Google Cloud Fraud Defense)**. Register the deployed host and use the site's public key. Keep App Check enforcement enabled for Firebase AI Logic. Follow the [App Check web setup](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider).
3. Copy `.env.example` to `.env` in this folder. Fill all six `VITE_FIREBASE_*` entries from the web app config and `VITE_APPCHECK_SITE_KEY` from reCAPTCHA. They are intentionally empty in the example. Vite web environment values appear in the client bundle; never put service-account keys or private Gemini keys there.
4. For localhost only, optionally set `VITE_APPCHECK_DEBUG_TOKEN=true`. Start dev, allow cloud and request a brief. Register the debug token printed by App Check in Firebase Console → App Check → your app → Manage debug tokens, then retry. Do not commit the printed token. See [App Check debug provider](https://firebase.google.com/docs/app-check/web/debug-provider).
5. Restart Vite after changing `.env`. Enable **Allow cloud when on-device AI is unavailable** and request a brief. Configuration failures produce a friendly retry state. Missing configuration never enables fallback.

`.env`, local overrides, build output and `node_modules` are git-ignored. There is no backend server, authentication, analytics, remote database or deployment step.

## Test instructions for judges

### On-device / Gemini Nano

1. Use a current supported **Chrome desktop** release and a secure context (localhost is supported). Check the current [Chrome Prompt API hardware and availability requirements](https://developer.chrome.com/docs/ai/prompt-api); eligibility depends on OS, RAM/VRAM, free disk space and browser rollout. Current documentation lists desktop web support in Chrome 148+. Mobile browsers are not a substitute.
2. Open the app. Leave cloud off. Inspect **On-device model: available / downloadable / downloading / unavailable**. Use **Check again** after browser changes. `chrome://on-device-internals` can help diagnose Chrome's model installation. No extension or obsolete origin-trial token is included in the app.
3. If downloadable, click **Download on-device model** while online. That user gesture starts the download and shows progress. If already downloading, **Show model download progress** attaches a monitor. Wait until available.
4. Keep samples, set sleep to 7 hours, soreness to 3 and energy to Okay, then click **Get today's brief**. Expect **20–40 minutes at RPE 4–6**, a preference for fresh upper push, and **Avoid legs** citing yesterday's squats and RPE 9. Today can name exercises such as push-ups and light dumbbell press. The result reports **On this device**, local-data reassurance and elapsed time. Repeat: the recovery decision stays consistent. Set sleep to 4 or soreness to 8 to get rest or easy 15–20 minute walking/mobility instead. If local generation takes over 1.5 seconds, expect the first-run wait message. Contradictory advice is visibly adjusted.
5. To verify offline inference, first load the app and model, then select Offline in DevTools Network and request another brief. Leave the page open. The app should use local inference; without a ready model it explains why a brief cannot be produced.

### Cloud fallback and privacy

1. Complete Firebase/App Check setup above. Use a browser/profile where `LanguageModel` is unavailable, or a supported Chrome profile before downloading Nano. Leave cloud off and request a brief: a clear message offers **Allow cloud AI**; no cloud inference should occur.
2. Enable the toggle and click **Get today's brief**. Expect **Generated in the cloud (Gemini)** and its elapsed time. With Nano available, the same toggle still prefers the local model; it is not a force-cloud switch.
3. Inspect DevTools Network: Gemini requests go through Firebase AI Logic only for permitted cloud requests. With cloud off, no workout prompt is sent over the network. Turn cloud off during a pending request to cancel it and discard its result. Data already sent cannot be recalled.
4. Remove the configuration and restart: the page still renders, shows **Cloud fallback not configured**, and can infer locally if Nano is ready. No cloud inference is attempted even if consent was previously saved.

### UI, storage and automated checks

- Add and delete workouts, clear only samples, refresh, and confirm persistence. Empty history offers an add action. Sample data is never reinserted into a saved empty history.
- Use Tab / Shift+Tab / arrows / Enter. Test viewport widths **360, 768 and 1200px** for horizontal overflow. Check focus visibility, labels, live announcements, loading skeletons, retry and reduced motion.
- Run `npm test`: 75 tests cover recovery scenarios and thresholds, relative dates, real Nano meal examples, exercise/time/RPE validation, prompt/parser behavior, idle warm-up and download prevention, delayed loading UI and cancellation, reduced motion, consent, offline, App Check, source reporting and storage (including old sample migration). Native, SDK local and cloud paths share the same recovery guard. AI tests use explicit SDK/native stubs; UI tests execute the main module against a small DOM and clock fixture. An isolated contract test runs the **real installed Firebase browser SDK** against simulated Chrome and HTTP boundaries to verify routing and schema serialization. Tests make **no real model or external network calls**.
- Run `npm run build`; run `npm run dev` and check the page. Automated unit success does not certify browser model eligibility or project credentials. Real Nano / App Check / cloud requests require the environment above.

## Built during the hackathon

All application code, prompts, tests and documentation in this repository were newly created for the **November 24–30, 2026** hackathon window, starting November 24, 2026. Firebase and Vite are pre-existing third-party dependencies; no existing application implementation was copied.

## Pre-existing work disclosure

Visual design tokens and conventions were adapted from the author's **Activity Log** app: `docs/DESIGN_SYSTEM.md`, `docs/DESIGN_RULES.md` and light-mode tokens in `src/styles.css`. This includes the green accent, neutral palette, system font stack, 12/16px radii, restrained type scale and spacing. Those reference files were read-only and were not modified. No existing workout logic, AI integration or source components were reused.

## License

[Apache License 2.0](LICENSE). Copyright **2026 Activity Log Coach contributors**. Third-party packages retain their own licenses.
