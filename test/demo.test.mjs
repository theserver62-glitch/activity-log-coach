import test from 'node:test';
import assert from 'node:assert/strict';
import { editTimeline, makeSrt } from '../scripts/make-video.mjs';

test('demo caption timing follows download cuts and the three-second title card', () => {
  const edit = editTimeline([
    { t: 0, caption: 'Opening scene' },
    { t: 4, caption: '', cutStart: true },
    { t: 14, caption: '', cutEnd: true },
    { t: 14, caption: 'On-device scene' },
    { t: 20, caption: 'Cloud scene' },
    { t: 25, caption: '', end: true },
  ], 26);
  assert.deepEqual(edit.kept, [[0, 4], [14, 25]]);
  assert.equal(edit.duration, 21);
  assert.deepEqual(edit.captions.map(({ start, end }) => [start, end]), [[3, 7], [7, 13], [13, 18]]);
  assert.match(makeSrt(edit.captions), /00:00:13,000 --> 00:00:18,000\nCloud scene/);
});

test('the cloud caption fits two lines and caption text remains plain text', () => {
  const caption = 'No on-device model? With your consent, Firebase AI Logic falls back to Gemini in the cloud, protected by App Check.';
  const srt = makeSrt([{ start: 3, end: 8, caption }]);
  const lines = srt.trim().split('\n').slice(2);
  assert.equal(lines.length, 2);
  assert.equal(lines.join(' '), caption);
  assert.ok(lines.every(line => line.length <= 72));
  const plainText = makeSrt([{ start: 3, end: 8, caption: '<b>Text</b> {\\pos(1,1)}' }]).trim().split('\n').slice(2).join('\n');
  assert.doesNotMatch(plainText, /[<>{}\\]/);
});

test('captions that exceed the two-line band fail instead of covering the app', () => {
  assert.throws(() => makeSrt([{ start: 3, end: 8, caption: 'caption '.repeat(30) }]), /more than two lines/);
  assert.throws(() => makeSrt([{ start: 3, end: 8, caption: 'W'.repeat(73) }]), /word is too long/);
});

test('saved failed recordings cannot be presented as a completed demo', () => {
  assert.throws(() => editTimeline([
    { t: 0, caption: 'Opening scene' },
    { t: 5, caption: '', failed: true, message: 'Cloud request failed' },
  ], 6), /Recording failed: Cloud request failed/);
});
