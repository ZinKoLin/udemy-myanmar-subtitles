const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function cache(saved = {}, tabs = []) {
  let now = Date.now();
  const deleted = [];
  const context = vm.createContext({ URL, TextEncoder, Date: class extends Date { static now() { return now; } }, chrome: {
    storage: { local: {
      async get(keys) { return keys === null ? structuredClone(saved) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(saved[key])])); },
      async set(values) { Object.assign(saved, structuredClone(values)); },
      async remove(keys) { for (const key of keys) { assert.ok(key.startsWith('translation:')); deleted.push(key); delete saved[key]; } }
    } }, tabs: { async query() { return tabs; } }
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../cache-store.js'), 'utf8') + '\nthis.cache = TranslationCache;', context);
  return { api: context.cache, saved, tabs, deleted, age(days) { now += days * 86400000; } };
}
const tab = (id, lecture = 1) => ({ id, url: `https://www.udemy.com/course/test/learn/lecture/${lecture}#overview` });
const sender = value => ({ tab: { id: value.id }, url: value.url });

test('Coursera and Udemy current lectures are both protected while old subtitles are cleaned', async () => {
  const live = [tab(1), { id: 2, url: 'https://www.coursera.org/learn/test/lecture/one/introduction' }];
  const app = cache({}, live);
  await app.api.put('translation:udemy', ['တစ်'], sender(live[0]));
  await app.api.put('translation:coursera', ['နှစ်'], sender(live[1]));
  await app.api.put('translation:old', ['old']); app.age(31);
  assert.equal(await app.api.cleanup(true), 1); assert.ok(app.saved['translation:udemy']); assert.ok(app.saved['translation:coursera']);
});

test('expiry and manual cleanup preserve every open lecture, credentials and settings across worker restart', async () => {
  const tabs = [tab(1), tab(2, 2)];
  const saved = { apiKeys: ['secret'], geminiAccountIndex: 2, geminiAccountEmail: 'pro@example.test', geminiBrowserModel: 'hydrogen-medium', n8nToken: 'token', subtitlePreferences: { fontSize: 30 } };
  const app = cache(saved, tabs);
  await app.api.put('translation:one', ['တစ်'], sender(tabs[0]));
  await app.api.put('translation:two', ['နှစ်'], sender(tabs[1]));
  await app.api.put('translation:old', ['အဟောင်း']);
  app.age(31); assert.equal(await app.api.cleanup(), 1);
  const restarted = cache(saved, tabs); assert.equal(await restarted.api.cleanup(true), 0);
  assert.deepEqual(saved['translation:one'], ['တစ်']); assert.deepEqual(saved['translation:two'], ['နှစ်']);
  assert.deepEqual(saved.apiKeys, ['secret']); assert.equal(saved.geminiAccountEmail, 'pro@example.test');
  assert.equal(saved.n8nToken, 'token'); assert.equal(saved.geminiBrowserModel, 'hydrogen-medium'); assert.equal(saved.subtitlePreferences.fontSize, 30);
  tabs[0] = tab(1, 3); assert.equal(await restarted.api.cleanup(true), 0); // New, unregistered page is protected conservatively.
  await restarted.api.get('translation:new-lecture', sender(tabs[0]));
  assert.equal(await restarted.api.cleanup(true), 1); assert.equal(saved['translation:one'], undefined);
  assert.deepEqual(saved['translation:two'], ['နှစ်']);
});

test('size budget evicts least recently used inactive cache and allows protected lectures to exceed the target', async () => {
  const app = cache(); const large = ['x'.repeat(1600000)];
  await app.api.put('translation:a', large); app.age(1);
  await app.api.put('translation:b', large); app.age(1);
  await app.api.get('translation:a'); app.age(1);
  await app.api.put('translation:c', large);
  assert.equal(app.saved['translation:b'], undefined); assert.ok(app.saved['translation:a']); assert.ok(app.saved['translation:c']);
  const active = cache({}, [tab(1)]);
  await active.api.put('translation:active', ['x'.repeat(4500000)], sender(active.tabs[0]));
  active.age(60); await active.api.cleanup(); assert.ok(active.saved['translation:active']);
});

test('upgrade migration pins the previous full-file job; unknown legacy tabs defer eviction', async () => {
  const saved = { 'translation:current': ['မြန်မာ'], 'translation:old': ['old'], browserSubtitleJob: { cacheKey: 'translation:current', ownerTab: 1, ownerUrl: tab(1).url } };
  const app = cache(saved, [tab(1)]); await app.api.cleanup(); app.age(31);
  assert.equal(await app.api.cleanup(), 1); assert.ok(saved['translation:current']);
  app.tabs.push(tab(2)); await app.api.put('translation:old-again', ['old']); app.age(31);
  assert.equal(await app.api.cleanup(), 0); assert.ok(saved['translation:old-again']);
  app.tabs.length = 0; assert.equal(await app.api.cleanup(true), 2);
});

test('entry count and concurrent writes cannot remove settings or lose newly cached translations', async () => {
  const saved = { apiKey: 'secret', translationCacheIndexV1: { apiKey: { used: 1, bytes: 9999999 } } };
  for (let i = 0; i < 505; i++) saved['translation:' + i] = ['text'];
  const app = cache(saved); assert.equal(await app.api.cleanup(), 5);
  assert.equal(saved.apiKey, 'secret');
  await Promise.all(Array.from({ length: 10 }, (_, i) => app.api.put('translation:new' + i, ['မြန်မာ'])));
  assert.equal(Object.keys(saved).filter(key => key.startsWith('translation:')).length, 500);
  for (let i = 0; i < 10; i++) assert.deepEqual(saved['translation:new' + i], ['မြန်မာ']);
});
test('metadata quota failure does not block reading or delete an existing current translation', async () => {
  const saved = { 'translation:current': ['မြန်မာ'], apiKey: 'secret' };
  const app = cache(saved, [tab(1)]);
  // Simulate a legacy store with no free room for the new metadata, without touching existing values.
  const contextSource = fs.readFileSync(require.resolve('../cache-store.js'), 'utf8');
  const context = vm.createContext({ URL, TextEncoder, Date, chrome: {
    storage: { local: { async get(keys) { return keys === null ? structuredClone(saved) : { [keys]: saved[keys] }; }, async set() { throw new Error('QUOTA_BYTES'); }, async remove() { assert.fail('Current cache must not be removed'); } } },
    tabs: { async query() { return app.tabs; } }
  } });
  vm.runInContext(contextSource + '\nthis.cache = TranslationCache;', context);
  assert.deepEqual(await context.cache.get('translation:current', sender(tab(1))), ['မြန်မာ']);
  assert.equal(saved.apiKey, 'secret');
});
