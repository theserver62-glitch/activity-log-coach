import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, DEMO, workspacePath, ffmpeg, mediaInfo } from './demo-media.mjs';

const CARD_SECONDS = 3;
const FONT = 'C\\:/Windows/Fonts/segoeui.ttf'; // Colon escaped for FFmpeg's filter parser, not a shell.

export function editTimeline(timeline, rawDuration) {
  if (!Array.isArray(timeline) || !timeline.length) throw new Error('Timeline must be a nonempty array.');
  // The recorded video can run about 1% shorter than wall-clock time; spread small drift instead of rejecting the take.
  const last = timeline.at(-1).t;
  if (Number.isFinite(last) && last > rawDuration + 0.25 && last <= rawDuration * 1.03) {
    timeline = timeline.map(event => ({ ...event, t: event.t * rawDuration / last }));
  }
  const cuts = [];
  let cutStart;
  let previous = -1;
  let end;
  for (const event of timeline) {
    if (!Number.isFinite(event.t) || event.t < previous || event.t < 0 || typeof event.caption !== 'string') {
      throw new Error('Timeline entries must have increasing nonnegative t (seconds) and a caption string.');
    }
    if (event.failed) throw new Error(`Recording failed: ${event.message || 'Record a complete take first.'}`);
    if (end !== undefined) throw new Error('The end marker must be the final timeline event.');
    previous = event.t;
    if (event.cutStart) {
      if (cutStart !== undefined) throw new Error('Nested cutStart markers are not supported.');
      cutStart = event.t;
    }
    if (event.cutEnd) {
      if (cutStart === undefined || event.t <= cutStart) throw new Error('cutEnd needs an earlier cutStart.');
      cuts.push([cutStart, event.t]);
      cutStart = undefined;
    }
    if (event.end) end = event.t;
  }
  if (cutStart !== undefined) throw new Error('The download cut has no cutEnd.');
  // Allow a small frame-rounding difference between Date.now() and the encoder.
  if (previous > rawDuration + 0.25) throw new Error('Timeline extends past the raw video. Use the matching recording.');
  const inputEnd = Math.min(end ?? rawDuration, rawDuration);
  if (cuts.some(([, stop]) => stop > inputEnd)) throw new Error('A cut extends past the video end.');
  const kept = [];
  let cursor = 0;
  for (const [start, stop] of cuts) {
    if (start > cursor) kept.push([cursor, start]);
    cursor = stop;
  }
  if (cursor < inputEnd) kept.push([cursor, inputEnd]);
  if (!kept.length) throw new Error('The cuts remove the entire recording.');
  const mapTime = t => t - cuts.reduce((sum, [start, stop]) => sum + Math.max(0, Math.min(t, stop) - start), 0);
  let bodyDuration = kept.reduce((sum, [start, stop]) => sum + stop - start, 0);
  const captions = timeline.filter(event => event.caption.trim() && !event.cutStart && !event.cutEnd && !event.end &&
    !cuts.some(([start, stop]) => event.t >= start && event.t < stop))
    .map(event => ({ start: mapTime(event.t), caption: event.caption.trim() }));
  if (!captions.length) throw new Error('Timeline has no visible captions.');
  // Preserve real pacing. Never speed up inference or silently truncate a scene.
  for (let index = 0; index < captions.length - 1; index++) {
    if (captions[index + 1].start - captions[index].start < 3 - 0.001) {
      throw new Error('Captions must be spaced at least 3 seconds apart after cuts. Adjust the timeline or retake.');
    }
  }
  bodyDuration = Math.max(bodyDuration, captions.at(-1).start + 3);
  // Round up to whole output frames so even the last caption lasts 3 seconds.
  bodyDuration = Math.ceil((bodyDuration - 1e-8) * 30) / 30;
  const duration = bodyDuration + CARD_SECONDS * 2;
  if (duration >= 180) throw new Error(`The edit would be ${duration.toFixed(2)} s. Retake or mark additional cuts to stay under 3:00.`);
  return {
    kept, bodyDuration, duration,
    captions: captions.map((caption, index) => ({
      ...caption, start: caption.start + CARD_SECONDS,
      end: (captions[index + 1]?.start ?? bodyDuration) + CARD_SECONDS,
    })),
  };
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:` +
    `${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function wrapCaption(text) {
  // Plain text only: prevent timeline text from being interpreted as ASS/HTML tags.
  const words = text.replace(/[<>{}\\]/g, '').split(/\s+/);
  const lines = [''];
  for (const word of words) {
    if (word.length > 72) throw new Error('A caption word is too long. Shorten it to fit the caption band.');
    const last = lines.length - 1;
    if (lines[last] && lines[last].length + word.length + 1 > 72) lines.push(word);
    else lines[last] += `${lines[last] ? ' ' : ''}${word}`;
  }
  if (lines.length > 2) throw new Error('A caption needs more than two lines. Shorten it to fit the caption band.');
  return lines.join('\n');
}

export function makeSrt(captions) {
  return captions.map((caption, index) => `${index + 1}\n${srtTime(caption.start)} --> ${srtTime(caption.end)}\n${wrapCaption(caption.caption)}\n`).join('\n');
}

export async function makeVideo({ rawPath, timelinePath, outputDir = DEMO }) {
  rawPath = workspacePath(rawPath);
  timelinePath = workspacePath(timelinePath);
  outputDir = workspacePath(outputDir);
  await mkdir(outputDir, { recursive: true });
  const { duration: rawDuration } = await mediaInfo(rawPath, outputDir);
  const edit = editTimeline(JSON.parse(await readFile(timelinePath, 'utf8')), rawDuration);
  await writeFile(path.join(outputDir, 'captions.srt'), makeSrt(edit.captions));
  await writeFile(path.join(outputDir, 'title.txt'), 'Activity Log Coach\n— on-device first, cloud when needed');
  await writeFile(path.join(outputDir, 'end.txt'), 'Firebase AI Logic · Gemini Nano · App Check');
  const filters = [];
  if (edit.kept.length > 1) filters.push(`[0:v]split=${edit.kept.length}${edit.kept.map((_, i) => `[source${i}]`).join('')}`);
  for (const [[start, end], index] of edit.kept.map((segment, i) => [segment, i])) {
    const source = edit.kept.length > 1 ? `source${index}` : '0:v';
    filters.push(`[${source}]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=1280:720:force_original_aspect_ratio=decrease:in_range=pc:out_range=tv,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xF2F3F4,` +
      `fps=30,setsar=1,settb=AVTB[part${index}]`);
  }
  const joined = edit.kept.map((_, i) => `[part${i}]`).join('');
  filters.push(`${joined}concat=n=${edit.kept.length}:v=1:a=0,` +
    `tpad=stop_mode=clone:stop_duration=3,trim=duration=${edit.bodyDuration.toFixed(6)},setpts=PTS-STARTPTS,` +
    `pad=1280:820:0:0:color=0x1A1D20[body]`);
  for (const [index, filename, name] of [[1, 'title.txt', 'title'], [2, 'end.txt', 'end']]) {
    filters.push(`[${index}:v]drawtext=fontfile='${FONT}':textfile='${filename}':expansion=none:` +
      `fontsize=42:fontcolor=0x1A1D20:line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2,setsar=1,settb=AVTB[${name}]`);
  }
  // Render only inside the added strip. libass force_style uses SSA alignment
  // values: 10 is middle-center. Matching PlayRes preserves the 28 px font size.
  const style = 'PlayResX=1280,PlayResY=100,FontName=Segoe UI,Fontsize=28,PrimaryColour=&H00FFFFFF,' +
    'BorderStyle=1,Outline=0,Shadow=0,Alignment=10,MarginL=48,MarginR=48,MarginV=0,WrapStyle=2';
  filters.push('[title][body][end]concat=n=3:v=1:a=0,split[canvas][caption-source]');
  // Relative subtitle path + cwd avoids Windows drive-colon/backslash ambiguity.
  filters.push(`[caption-source]crop=1280:100:0:720,` +
    `subtitles=filename='captions.srt':original_size=1280x100:force_style='${style}'[caption-band]`);
  filters.push('[canvas][caption-band]overlay=x=0:y=720,format=yuv420p[out]');
  await writeFile(path.join(outputDir, 'render.ffgraph'), filters.join(';\n'));
  const pending = path.join(outputDir, '.rendering.mp4');
  console.log(`Rendering ${edit.duration.toFixed(2)} s (download cuts removed; 3 s title + 3 s end card)…`);
  await ffmpeg(['-y', '-i', rawPath,
    '-f', 'lavfi', '-i', 'color=c=0xF2F3F4:s=1280x820:r=30:d=3',
    '-f', 'lavfi', '-i', 'color=c=0xF2F3F4:s=1280x820:r=30:d=3',
    '-filter_complex_script', 'render.ffgraph', '-map', '[out]', '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-threads', '4',
    '-r', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', pending], { cwd: outputDir });
  const result = await mediaInfo(pending, outputDir);
  if (result.duration >= 180 || Math.abs(result.duration - edit.duration) > 0.2) {
    throw new Error(`Encoded duration ${result.duration}s did not meet the edit contract. See ${pending}.`);
  }
  if (!/Video: h264/.test(result.output) || !/1280x820/.test(result.output) || !/30 fps/.test(result.output) || !/yuv420p/.test(result.output)) {
    throw new Error('The encoded stream did not match H.264 / 1280x820 / 30 fps / yuv420p.');
  }
  const output = path.join(outputDir, 'demo.mp4');
  await rename(pending, output);
  console.log(`Video: ${output}\nCaptions: ${path.join(outputDir, 'captions.srt')}`);
  console.log(`Final duration: ${Math.floor(result.duration / 60)}:${(result.duration % 60).toFixed(2).padStart(5, '0')} (${result.duration.toFixed(2)} s; under 3:00)`);
  return { ...edit, output, actualDuration: result.duration };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/make-video.mjs [demo/raw/00-demo.webm] [demo/timeline.json]\nDefaults to the first .webm in demo/raw. Outputs demo/demo.mp4 and demo/captions.srt.');
    return;
  }
  let raw = process.argv[2];
  if (!raw) {
    const files = (await readdir(path.join(DEMO, 'raw'))).filter(file => file.endsWith('.webm')).sort();
    if (!files.length) throw new Error('No raw .webm found. Run record-demo.mjs outside the sandbox first.');
    raw = path.join(DEMO, 'raw', files[0]);
  }
  await makeVideo({ rawPath: raw, timelinePath: process.argv[3] || path.join(DEMO, 'timeline.json') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(ROOT);
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
