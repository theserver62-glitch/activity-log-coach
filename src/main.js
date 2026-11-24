import './styles.css';
import { coachAI, friendlyError } from './ai.js';
import { localDate, recentWorkouts, humanDate, humanizeDates } from './brief.js';
import { delayedDeviceMessage } from './loading.js';
import { loadState, saveState, validWorkout, validCheckIn } from './store.js';

const $ = selector => document.querySelector(selector);
const state = loadState();
let deviceStatus = 'checking';
let downloading = false;
let activeRequest;
let requestNumber = 0;
let displayedSource;
const titleCase = text => text.charAt(0).toUpperCase() + text.slice(1);
const energyLevels = ['low', 'okay', 'high'];

// Never interpolate user or model content as HTML.
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function persist() {
  if (!saveState(state)) {
    $('#storage-notice').textContent = 'Browser storage is full or blocked. Changes will last only in this tab.';
    $('#storage-notice').hidden = false;
  }
}

function resetBrief(message = 'Your context changed. Get a new brief when you’re ready.') {
  requestNumber += 1;
  activeRequest?.abort();
  activeRequest = undefined;
  $('#get-brief').disabled = false;
  $('#get-brief span').textContent = "Get today's brief";
  $('#brief-result').removeAttribute('aria-busy');
  displayedSource = undefined;
  renderSource();
  const placeholder = element('div', undefined, 'brief-placeholder');
  placeholder.append(element('p', 'Your next step starts here'), element('p', message, 'secondary'));
  $('#brief-result').replaceChildren(placeholder);
}

function renderLogs() {
  const list = $('#workout-list');
  list.replaceChildren();
  const sorted = [...state.logs].sort((a, b) => b.date.localeCompare(a.date));
  for (const log of sorted) {
    const item = element('li', undefined, 'workout-item');
    const content = element('div', undefined, 'workout-content');
    content.append(element('h3', humanizeDates(log.title) || `${titleCase(log.type)} · ${log.bodyArea}`));
    const summary = element('p', undefined, 'secondary workout-summary');
    const time = element('time', humanDate(log.date));
    time.dateTime = log.date;
    summary.append(time, element('span', ` · ${log.minutes} min · RPE ${log.rpe}`));
    summary.append(element('span', ` · ${log.bodyArea}${log.sample ? ' · Sample data' : ''}`, 'sr-only'));
    content.append(summary);
    const remove = element('button', '×', 'delete-button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete ${humanizeDates(log.title) || log.type} (${humanDate(log.date)})`);
    remove.addEventListener('click', () => {
      const index = sorted.indexOf(log);
      state.logs = state.logs.filter(entry => entry.id !== log.id);
      persist(); renderLogs(); resetBrief();
      $('#log-status').textContent = 'Workout deleted.';
      const buttons = list.querySelectorAll('button');
      (buttons[Math.min(index, buttons.length - 1)] || $('#add-workout summary')).focus();
    });
    item.append(content, remove);
    list.append(item);
  }
  $('#sample-bar').hidden = !state.logs.some(log => log.sample);
  $('#empty-logs').hidden = state.logs.length > 0;
}

function renderPrivacy() {
  $('#allow-cloud').checked = state.allowCloud;
  $('#config-notice').hidden = coachAI.cloudConfigured;
  $('#cloud-status').textContent = state.allowCloud ? (coachAI.cloudConfigured ? 'On' : 'Unavailable') : 'Off';
  $('#privacy-explanation').textContent = state.allowCloud && coachAI.cloudConfigured
    ? 'If local AI is unavailable, your last 7 days of workouts and today’s check-in may be sent to Google Gemini.'
    : 'Cloud is off. Your workouts and check-in stay on this device.';
}

function renderSource() {
  const local = displayedSource === 'on_device';
  $('#source-badge').textContent = displayedSource
    ? local ? '✓ On this device' : 'Cloud (Gemini)'
    : activeRequest ? '◌ Creating your brief'
      : deviceStatus === 'available' ? '✓ Ready on this device' : `◌ On-device model: ${deviceStatus}`;
  $('#source-help').textContent = local ? 'Your data stayed on this device.' : '';
  $('#source-help').hidden = !local;
  $('#brief-start').hidden = Boolean(displayedSource || activeRequest);
  if (!displayedSource) {
    $('#generation-meta').textContent = '';
    $('#generation-meta').hidden = true;
  }
}

function renderNetwork() {
  $('#network-status').hidden = navigator.onLine;
  $('#network-status').textContent = deviceStatus === 'available'
    ? 'You’re offline. Your downloaded on-device model can still create a brief.'
    : 'You’re offline. Logging still works. Reconnect to download the on-device model or use cloud AI.';
}

async function refreshDevice() {
  deviceStatus = await coachAI.getDeviceStatus();
  coachAI.scheduleDeviceWarmup(deviceStatus);
  $('#device-status').textContent = `On-device model: ${deviceStatus}`;
  $('#download-area').hidden = downloading || !['downloadable', 'downloading'].includes(deviceStatus);
  $('#download-model').textContent = deviceStatus === 'downloading' ? 'Show model download progress' : 'Download on-device model';
  $('#download-model').disabled = !navigator.onLine;
  $('#device-help').textContent = deviceStatus === 'unavailable'
    ? 'Use a supported Chrome desktop browser for Gemini Nano, or allow cloud AI.'
    : deviceStatus === 'available' ? 'Ready here. Your brief can work without a connection.' : '';
  renderNetwork();
  renderSource();
}

function readCheckIn() {
  const form = new FormData($('#check-in-form'));
  return { date: localDate(), sleep: Number(form.get('sleep')), soreness: Number(form.get('soreness')), energy: energyLevels[Number(form.get('energy'))], note: String(form.get('note')).slice(0, 140) };
}

function updateCheckIn() {
  const energy = titleCase(energyLevels[Number($('#energy').value)]);
  $('#energy-value').textContent = energy;
  $('#energy').setAttribute('aria-valuetext', energy);
  $('#sleep-value').textContent = `${$('#sleep').value} h`;
  $('#sleep').setAttribute('aria-valuetext', `${$('#sleep').value} hours`);
  $('#soreness-value').textContent = `${$('#soreness').value}/10`;
  $('#soreness').setAttribute('aria-valuetext', `${$('#soreness').value} out of 10`);
  $('#note-count').textContent = `${$('#note').value.length} / 140`;
  const value = readCheckIn();
  if ($('#check-in-form').checkValidity() && validCheckIn(value)) { state.checkIn = value; persist(); }
}

function renderLoading() {
  displayedSource = undefined;
  renderSource();
  $('#brief-result').setAttribute('aria-busy', 'true');
  const loading = element('div', undefined, 'brief-loading');
  const message = element('p', 'Putting your day in perspective…', 'secondary');
  loading.append(message);
  for (const name of ['Today', 'Avoid', 'Meal']) {
    const row = element('div', undefined, 'skeleton-row');
    row.setAttribute('aria-hidden', 'true');
    row.append(element('span', name), element('span', '', 'skeleton'));
    loading.append(row);
  }
  $('#brief-result').replaceChildren(loading);
  return message;
}

function renderBrief(brief, elapsedMs) {
  const body = element('div', undefined, 'brief-content');
  const rows = element('dl', undefined, 'brief-rows');
  for (const [key, label] of [['today', 'Today'], ['avoid', 'Avoid'], ['meal', 'Meal']]) {
    const row = element('div', undefined, `brief-row ${key}`);
    row.append(element('dt', label), element('dd', brief[key]));
    rows.append(row);
  }
  body.append(rows);
  if (brief.why) body.append(element('p', brief.why, 'brief-why'));
  if (brief.adjusted) body.append(element('p', 'Checked against your recovery facts.', 'secondary adjustment-note'));
  if (state.logs.some(log => log.sample)) body.append(element('p', 'Includes sample workouts.', 'secondary sample-footnote'));
  $('#brief-result').replaceChildren(body);
  displayedSource = brief.inferenceSource;
  renderSource();
  $('#generation-meta').textContent = `${displayedSource === 'on_device' ? 'Made on this device' : 'Made in the cloud (Gemini)'} · ${(elapsedMs / 1000).toFixed(1)} s`;
  $('#generation-meta').hidden = false;
}

function renderError(error) {
  const body = element('div', undefined, 'brief-error');
  body.append(element('h3', 'Let’s try that again.'), element('p', friendlyError(error)));
  const retry = element('button', 'Retry brief', 'text-button');
  retry.type = 'button';
  retry.addEventListener('click', () => $('#check-in-form').requestSubmit());
  body.append(retry);
  if (!state.allowCloud && ['device', 'download'].includes(error.code)) {
    const enable = element('button', 'Allow cloud AI', 'secondary-button');
    enable.type = 'button';
    enable.addEventListener('click', () => {
      state.allowCloud = true; persist(); renderPrivacy();
      resetBrief(coachAI.cloudConfigured ? 'Cloud fallback is allowed. Get your brief when you’re ready.' : 'Cloud fallback not configured. Add Firebase settings to enable it; on-device AI is still available on supported devices.');
      $('#get-brief').focus();
    });
    body.append(enable);
  }
  if (!coachAI.cloudConfigured) body.append(element('p', 'Cloud fallback not configured. See README for Firebase setup, or use a supported Chrome desktop device.', 'secondary'));
  $('#brief-result').replaceChildren(body);
}

$('#check-in-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (activeRequest) return;
  updateCheckIn();
  if (!validCheckIn(state.checkIn)) return;
  const id = ++requestNumber;
  activeRequest = new AbortController();
  $('#get-brief').disabled = true;
  $('#get-brief span').textContent = 'Creating your brief…';
  const loadingMessage = renderLoading();
  const signal = activeRequest.signal;
  let stopLoadingMessage;
  try {
    const startedAt = performance.now();
    const brief = await coachAI.generateBrief({
      logs: [...state.logs], checkIn: { ...state.checkIn }, today: localDate(), allowCloud: state.allowCloud, signal,
      onDeviceStart: () => {
        stopLoadingMessage = delayedDeviceMessage(text => {
          if (id === requestNumber) loadingMessage.textContent = text;
        }, { signal });
      },
    });
    const elapsedMs = performance.now() - startedAt;
    if (id === requestNumber) renderBrief(brief, elapsedMs);
  } catch (error) {
    if (id === requestNumber) renderError(error);
  } finally {
    stopLoadingMessage?.();
    if (id === requestNumber) {
      // Release any SDK-created Chrome session through its creation signal.
      activeRequest?.abort();
      activeRequest = undefined;
      $('#get-brief').disabled = false;
      $('#get-brief span').textContent = "Get today's brief";
      $('#brief-result').removeAttribute('aria-busy');
      renderSource();
    }
    void refreshDevice();
  }
});

$('#check-in-form').addEventListener('input', event => {
  if (event.target.id === 'allow-cloud') return;
  updateCheckIn(); resetBrief();
});
$('#allow-cloud').addEventListener('change', event => {
  state.allowCloud = event.target.checked;
  persist(); renderPrivacy(); resetBrief('Privacy preference saved. Get a new brief when you’re ready.');
});
$('#workout-form').addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const log = { id: crypto.randomUUID(), type: data.get('type'), bodyArea: data.get('bodyArea'), minutes: Number(data.get('minutes')), rpe: Number(data.get('rpe')), date: data.get('date'), sample: false };
  if (!validWorkout(log) || log.date > localDate()) return;
  state.logs.push(log); persist(); renderLogs(); resetBrief();
  $('#add-workout').open = false;
  $('#add-workout summary').focus();
  $('#log-status').textContent = 'Workout saved in this browser.';
  event.currentTarget.reset(); $('#workout-date').value = localDate();
});
$('#clear-samples').addEventListener('click', () => {
  state.logs = state.logs.filter(log => !log.sample);
  persist(); renderLogs(); resetBrief('Sample data cleared. Add a workout to make this brief yours.');
  $('#log-status').textContent = 'Sample workouts cleared.';
  $('#add-workout').open = true; $('#workout-type').focus();
});
$('#add-first').addEventListener('click', () => { $('#add-workout').open = true; $('#workout-type').focus(); });
$('#refresh-model').addEventListener('click', () => { void refreshDevice(); });
$('#download-model').addEventListener('click', async () => {
  downloading = true;
  $('#download-area').hidden = true;
  $('#download-progress-area').hidden = false;
  $('#download-status').textContent = 'Starting download…';
  $('#download-progress').value = 0;
  try {
    await coachAI.downloadDeviceModel(progress => {
      $('#download-progress').value = progress;
      $('#download-status').textContent = `Downloading model: ${Math.round(progress * 100)}%`;
      $('#device-status').textContent = 'On-device model: downloading';
    });
    $('#download-status').textContent = 'Download complete. Your on-device model is ready.';
  } catch {
    $('#download-status').textContent = 'The model could not download. Check Chrome support, free storage and your connection, then try again.';
  } finally { downloading = false; await refreshDevice(); }
});

for (const name of ['online', 'offline']) window.addEventListener(name, () => {
  if (name === 'offline' && activeRequest) resetBrief('Connection changed. Get a new brief using your on-device model.');
  renderNetwork(); void refreshDevice();
});
window.addEventListener('focus', () => {
  $('#workout-date').max = localDate();
  renderLogs();
  void refreshDevice();
});

$('#today-date').textContent = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
$('#workout-date').value = localDate();
$('#workout-date').max = localDate();
$('#sleep').value = Math.min(10, Math.max(3, Math.round(state.checkIn.sleep * 2) / 2));
$('#soreness').value = state.checkIn.soreness;
$('#energy').value = energyLevels.indexOf(state.checkIn.energy);
$('#note').value = state.checkIn.note;
$('#storage-notice').textContent = state.notice;
$('#storage-notice').hidden = !state.notice;
renderLogs(); renderPrivacy(); updateCheckIn(); renderNetwork();
if (state.logs.length && !recentWorkouts(state.logs).length) resetBrief('No workouts in the last 7 days. Add a recent workout, or get a brief based on today’s check-in.');
void refreshDevice();
