import { spawn } from 'node:child_process';
import { access, mkdir, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEMO = path.join(ROOT, 'demo');
export const FFMPEG = process.env.FFMPEG_PATH
  || 'C:/Users/these/AppData/Roaming/Python/Python311/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe';

export function workspacePath(value) {
  const absolute = path.resolve(ROOT, value);
  const relative = path.relative(ROOT, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Keep demo files inside the workspace: ${value}`);
  }
  return absolute;
}

export async function ffmpeg(args, { cwd = DEMO, probe = false } = {}) {
  await access(FFMPEG);
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], {
      cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = chunk => { output = (output + chunk.toString()).slice(-24000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || (probe && code === 1 && /Duration:/.test(output))) resolve(output);
      else reject(new Error(`ffmpeg exited ${code}:\n${output}`));
    });
  });
}

// The supplied distribution has ffmpeg but does not require a separate ffprobe.
export async function mediaInfo(file, cwd = DEMO) {
  const output = await ffmpeg(['-i', workspacePath(file)], { cwd, probe: true });
  const match = output.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`Could not read video duration: ${file}`);
  return { duration: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]), output };
}

export async function preparePlaywrightVideo() {
  if (process.platform !== 'win32') throw new Error('This recorder is configured for real Chrome on Windows.');
  // Playwright expects its own ffmpeg cache layout. Populate it from the supplied
  // binary, inside this repository; never download browsers or modify node_modules.
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'node_modules/playwright-core/browsers.json'), 'utf8'));
  const revision = manifest.browsers.find(browser => browser.name === 'ffmpeg')?.revision;
  if (!revision || !/^\d+$/.test(revision)) throw new Error('Missing Playwright ffmpeg revision.');
  const cache = path.join(DEMO, '.playwright');
  const executable = path.join(cache, `ffmpeg-${revision}`, 'ffmpeg-win64.exe');
  await mkdir(path.dirname(executable), { recursive: true });
  try { await access(executable); } catch { await copyFile(FFMPEG, executable); }
  // Must be set before importing playwright-core (its registry reads this once).
  process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}

export async function stitchTakes(takes, output) {
  output = workspacePath(output);
  const cwd = path.dirname(output);
  await mkdir(cwd, { recursive: true });
  const inputs = [];
  const filters = [];
  for (const [index, take] of takes.entries()) {
    const { duration } = await mediaInfo(take.file, cwd);
    // Discard pre-scene blank frames. Date.now() anchors each take, and the saved
    // video's duration aligns its tail with page.close(), to within frame rounding.
    const offset = Math.max(0, duration - (take.closedAt - take.startedAt) / 1000);
    inputs.push('-i', take.file);
    filters.push(`[${index}:v]trim=start=${offset.toFixed(3)},setpts=PTS-STARTPTS,fps=30,` +
      `tpad=stop_mode=clone:stop_duration=1,trim=duration=${take.duration.toFixed(3)},` +
      `settb=AVTB,setsar=1[v${index}]`);
  }
  filters.push(takes.map((_, index) => `[v${index}]`).join('') + `concat=n=${takes.length}:v=1:a=0[out]`);
  await ffmpeg(['-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]',
    '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '10',
    '-b:v', '2M', '-threads', '4', '-pix_fmt', 'yuv420p', output], { cwd });
}
