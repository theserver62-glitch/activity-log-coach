export const WARMUP_MESSAGE = 'Warming up the on-device model — the first brief can take about 10 seconds.';

// One quiet text change; existing skeleton CSS handles reduced-motion settings.
export function delayedDeviceMessage(onSlow, { signal, runtime = globalThis } = {}) {
  let timer;
  let stopped = false;
  const stop = () => {
    stopped = true;
    runtime.clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  };
  if (signal?.aborted) return stop;
  timer = runtime.setTimeout(() => {
    if (!stopped) onSlow(WARMUP_MESSAGE);
  }, 1500);
  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}
