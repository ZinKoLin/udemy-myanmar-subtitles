const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSubtitles, validateTranslations } = require('../core.js');
const { captionIndex } = require('../core.js');
test('subtitle preferences clamp sizes and reject unsafe CSS values', () => {
  const { preferences } = require('../core.js');
  assert.deepEqual(preferences(), { autoTranslate: true, fontSize: 26, fontColor: '#ffffff', verticalPosition: 20 });
  assert.deepEqual(preferences({ autoTranslate: false, fontSize: 999, fontColor: '#ffe066' }), { autoTranslate: false, fontSize: 48, fontColor: '#ffe066', verticalPosition: 20 });
  assert.equal(preferences({ fontSize: -5 }).fontSize, 16);
  assert.equal(preferences({ fontSize: 'invalid', fontColor: 'red;display:none' }).fontSize, 26);
  assert.equal(preferences({ fontColor: 'red;display:none' }).fontColor, '#ffffff');
  assert.equal(preferences({ verticalPosition: -10 }).verticalPosition, 0);
  assert.equal(preferences({ verticalPosition: 200 }).verticalPosition, 100);
  assert.equal(preferences({ verticalPosition: 'invalid' }).verticalPosition, 20);
});
test('closed-sidebar captions match whitespace and avoid stale text in gaps', () => {
  const cues = [{ text: 'Hello and welcome' }, { text: 'Python code' }, { text: 'Hello and welcome' }];
  assert.equal(captionIndex(cues, ' Hello\n and   welcome ', 0), 0);
  assert.equal(captionIndex(cues, 'Python code', 0), 1);
  assert.equal(captionIndex(cues, 'Hello and welcome', 2), 2);
  assert.equal(captionIndex(cues, '', 2), -1);
  assert.equal(captionIndex(cues, 'Different language or lesson', 1), -1);
  assert.equal(captionIndex(cues, 'Hello and welcome', -1), 0);
});
test('VTT identifiers, settings, multiline text, markup and silent gaps', () => {
  const cues = parseSubtitles('WEBVTT\n\nNOTE ignored\n00:00:00.000 --> 00:00:01.000\nnot a cue\n\nid-1\n00:00:02.000 --> 00:00:04.500 align:start\n<v Teacher>Hello &amp; welcome</v>\nNext line\n\n00:00:08.000 --> 00:00:09.000\nDone');
  assert.deepEqual(cues, [{ start: 2, end: 4.5, text: 'Hello & welcome\nNext line' }, { start: 8, end: 9, text: 'Done' }]);
});
test('SRT timestamps, BOM, Windows newlines and invalid timing', () => {
  const cues = parseSubtitles('\uFEFF1\r\n00:01:02,100 --> 00:01:04,200\r\nTest\r\n\r\n2\r\nbad --> 00:02:00,000\r\nInvalid\r\n\r\n3\r\n00:04:00,000 --> 00:03:00,000\r\nReversed');
  assert.deepEqual(cues, [{ start: 62.1, end: 64.2, text: 'Test' }]);
});
test('translation ids are reordered and missing, duplicate or empty items rejected', () => {
  assert.deepEqual(validateTranslations([{ id: 1, text: 'နှစ်' }, { id: 0, text: 'တစ်' }], 2), ['တစ်', 'နှစ်']);
  for (const items of [[], [{ id: 0, text: 'a' }, { id: 0, text: 'b' }], [{ id: 0, text: '' }, { id: 1, text: 'b' }], [{ id: 0, text: 'a' }, { id: 2, text: 'b' }]]) assert.throws(() => validateTranslations(items, 2));
});
