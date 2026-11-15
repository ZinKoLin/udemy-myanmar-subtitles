const { test } = require('node:test');
const assert = require('node:assert/strict');
const preview = require('../preview-core.js');
const resource = (asset = 123, startTime = 10) => ({ name: `https://vtt-cf.udemycdn.com/${asset}/en_US/original.vtt?Signature=abc`, startTime });

test('preview accepts only real English CDN VTT resources and excludes thumbnails and unrelated hosts', () => {
  assert.equal(preview.captionResource(resource()).asset, '123');
  for (const name of ['https://example.com/123/en_US/original.vtt', 'https://vtt-cf.udemycdn.com.evil.test/123/en_US/original.vtt', 'http://vtt-cf.udemycdn.com/123/en_US/original.vtt', 'https://vtt-cf.udemycdn.com/123/de_DE/original.vtt', 'https://mp4-c.udemycdn.com/123/thumb-sprites.vtt', 'https://vtt-cf.udemycdn.com:8443/123/en_US/original.vtt']) {
    assert.equal(preview.captionResource({ name, startTime: 0 }), null);
  }
});

test('preview selection cannot reuse old captions while the same video element changes source', () => {
  const tracker = preview.create();
  tracker.observe([resource()]);
  assert.equal(tracker.forSource('blob:first'), resource().name);
  assert.equal(tracker.forSource('blob:first'), resource().name);
  assert.equal(tracker.forSource('blob:missing-captions'), '');
  tracker.begin(100, 'blob:missing-captions');
  tracker.observe([resource(123, 50), resource(456, 110)]);
  assert.equal(tracker.forSource('blob:missing-captions'), '');
  assert.equal(tracker.forSource('blob:second'), resource(456, 110).name);
  assert.equal(tracker.forSource('blob:third'), '');
});

test('ambiguous preview resource history fails closed rather than translating another asset', () => {
  const tracker = preview.create();
  tracker.observe([resource(1), resource(2, 20)]);
  assert.equal(tracker.forSource('blob:unknown'), '');
  tracker.begin(30, 'blob:unknown');
  tracker.observe([resource(3, 40), resource(3, 50)]);
  assert.equal(tracker.forSource('blob:known'), resource(3, 50).name);
});
