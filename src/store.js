import { isDate, localDate } from './brief.js';

export const STORAGE_KEY = 'activity-log-coach.v1';
export const TYPES = ['strength', 'run', 'ride', 'swim', 'yoga', 'other'];
export const AREAS = ['legs', 'upper push', 'upper pull', 'core', 'full body', 'cardio'];
export const defaultCheckIn = () => ({ date: localDate(), sleep: 7, soreness: 3, energy: 'okay', note: '' });

export function sampleWorkouts(today = new Date()) {
  const dateFor = weekday => {
    const date = new Date(today);
    date.setDate(date.getDate() - (date.getDay() - weekday + 7) % 7);
    return localDate(date);
  };
  return [
    { id: 'sample-mon', title: 'Leg day · squats 5×5 heavy', type: 'strength', bodyArea: 'legs', minutes: 50, rpe: 9, date: dateFor(1), sample: true },
    { id: 'sample-tue', title: 'Easy run', type: 'run', bodyArea: 'cardio', minutes: 30, rpe: 4, date: dateFor(2), sample: true },
    { id: 'sample-wed', title: 'Upper-body push · bench press', type: 'strength', bodyArea: 'upper push', minutes: 45, rpe: 8, date: dateFor(3), sample: true },
  ];
}

export function validWorkout(log) {
  return log && typeof log.id === 'string' && TYPES.includes(log.type) && AREAS.includes(log.bodyArea)
    && isDate(log.date) && Number.isInteger(log.minutes) && log.minutes >= 1 && log.minutes <= 600
    && Number.isInteger(log.rpe) && log.rpe >= 1 && log.rpe <= 10;
}

export function validCheckIn(value) {
  return value && isDate(value.date) && Number.isFinite(value.sleep) && value.sleep >= 0 && value.sleep <= 24
    && Number.isInteger(value.soreness) && value.soreness >= 0 && value.soreness <= 10
    && ['low', 'okay', 'high'].includes(value.energy) && typeof value.note === 'string';
}

export function loadState(storage) {
  const empty = { logs: [], checkIn: defaultCheckIn(), allowCloud: false };
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY);
    if (raw === null) return { ...empty, logs: sampleWorkouts(), notice: '' };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.logs)) throw new Error('Invalid stored data');
    const seen = new Set();
    const logs = parsed.logs.filter(log => validWorkout(log) && !seen.has(log.id) && seen.add(log.id)).map(log => ({
      id: log.id, type: log.type, bodyArea: log.bodyArea, minutes: log.minutes, rpe: log.rpe, date: log.date,
      sample: log.sample === true, ...(typeof log.title === 'string' ? { title: log.title.slice(0, 80) } : {}),
    }));
    return {
      logs, allowCloud: parsed.allowCloud === true,
      checkIn: validCheckIn(parsed.checkIn) && parsed.checkIn.date === localDate()
        ? { ...parsed.checkIn, note: parsed.checkIn.note.slice(0, 140) } : defaultCheckIn(),
      notice: logs.length === parsed.logs.length ? '' : 'Some saved workouts could not be read. Your other entries are ready.',
    };
  } catch {
    return { ...empty, notice: 'Saved data is unavailable. You can use this tab; browser storage may be blocked.' };
  }
}

export function saveState(state, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, JSON.stringify({
      logs: state.logs, checkIn: state.checkIn, allowCloud: state.allowCloud,
    }));
    return true;
  } catch { return false; }
}
