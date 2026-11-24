import { fileURLToPath } from 'node:url';

// The JS API avoids shell-specific environment assignment on Windows.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
process.env.BASE_PATH = '/activity-log-coach/';
// Vite inlines VITE_* values; a debug token in the public bundle would let anyone pass App Check.
process.env.VITE_APPCHECK_DEBUG_TOKEN = '';
const { build } = await import('vite');
await build();
