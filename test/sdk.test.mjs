import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('installed Firebase browser SDK routes local/cloud requests and serializes the schema', () => {
  // Isolate Firebase's browser component registration from Node's SDK registration.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/sdk-browser.mjs', import.meta.url))], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
});
