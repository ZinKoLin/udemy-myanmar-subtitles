const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subtitleUrl } = require('../coursera-core.js');
const page = 'https://www.coursera.org/learn/test/lecture/one/introduction';

test('Coursera reads only its own signed English subtitle proxy, never arbitrary URLs or another language', () => {
  const english = { srclang: 'en', label: 'English', src: '/api/subtitleAssetProxy.v1/GEitlg4gTr-IrZYOIG6_Yw?expiry=123&hmac=abc&fileExtension=vtt' };
  assert.equal(subtitleUrl([{ ...english, srclang: 'fr', label: 'French' }, english], page), new URL(english.src, page).href);
  for (const src of ['https://evil.test/api/subtitleAssetProxy.v1/id?fileExtension=vtt', 'https://www.coursera.org.evil.test/api/subtitleAssetProxy.v1/id?fileExtension=vtt', '/api/users.v1/me?fileExtension=vtt', '/api/subtitleAssetProxy.v1/id?fileExtension=mp4', '/api/subtitleAssetProxy.v1/../users.v1/me?fileExtension=vtt']) assert.equal(subtitleUrl([{ ...english, src }], page), '');
  assert.equal(subtitleUrl([english], 'http://www.coursera.org/learn/test'), '');
  assert.equal(subtitleUrl([english], 'https://coursera.org.evil.test/learn/test'), '');
});
