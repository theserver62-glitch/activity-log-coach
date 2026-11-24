import { fileURLToPath } from 'node:url';

// The JS API avoids shell-specific environment assignment on Windows.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
process.env.BASE_PATH = '/activity-log-coach/';
const { build } = await import('vite');
await build();
