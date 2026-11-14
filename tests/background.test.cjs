const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../core.js');
function setup(saved = { apiKey: 'test-secret', model: 'gemini-2.5-flash-lite' }, initialNow = Date.now()) {
  if (saved.autoModelFallback === undefined) saved.autoModelFallback = false;
  let listener, calls = 0, access;
  let now = initialNow;
  const waits = [];
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: ClockDate,
    setInterval, clearInterval,
    setTimeout(resolve, milliseconds) { waits.push(milliseconds); now += milliseconds; queueMicrotask(resolve); },
    importScripts(...files) { for (const file of files) vm.runInContext(fs.readFileSync(require.resolve('../' + file), 'utf8'), context); }, SubtitleCore: core, crypto: globalThis.crypto, TextEncoder, AbortSignal, URL, URLSearchParams, Map,
    fetch: async () => {
      calls++;
      return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify([{ id: 0, text: 'မင်္ဂလာပါ' }]) }] } }] }) };
    },
    chrome: {
      storage: { local: {
        async setAccessLevel(value) { access = value.accessLevel; },
        async get(keys) { if (keys === null) return structuredClone(saved); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, saved[k]])); },
        async set(value) { Object.assign(saved, value); }, async remove(keys) { for (const key of keys) delete saved[key]; }
      } },
      tabs: { async query() { return []; } }, alarms: { async get() {}, async create() {}, onAlarm: { addListener() {} } },
      runtime: { id: 'extension-test', getURL: path => 'chrome-extension://extension-test/' + path, onMessage: { addListener(fn) { listener = fn; } } }
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), context);
  const sender = { id: 'extension-test', url: 'https://www.udemy.com/course/test/learn/lecture/1' };
  return {
    saved, waits, get now() { return now; }, get calls() { return calls; }, get access() { return access; },
    send(texts) { return new Promise(resolve => listener({ type: 'TRANSLATE', texts }, sender, resolve)); },
    message(message) { return new Promise(resolve => listener(message, sender, resolve)); },
    listener, context
  };
}
test('cache survives worker restart and needs no API key on a cache hit', async () => {
  const app = setup();
  const first = await app.send(['Hello']);
  assert.equal(first.ok, true); assert.equal(first.cached, false); assert.equal(app.calls, 1);
  assert.equal(app.access, 'TRUSTED_CONTEXTS');
  delete app.saved.apiKey;
  vm.runInContext('pending.clear()', app.context);
  const second = await app.send(['Hello']);
  assert.equal(second.ok, true); assert.equal(second.cached, true); assert.equal(app.calls, 1);
  assert.equal(second.texts[0], 'မင်္ဂလာပါ');
  const miss = await app.send(['Different']);
  assert.equal(miss.ok, false); assert.equal(app.calls, 1);
});
test('untrusted senders and lookalike hosts cannot request translation', () => {
  const app = setup();
  for (const url of ['https://udemy.com.evil.test/', 'http://www.udemy.com/', 'https://example.com/']) {
    assert.equal(app.listener({ type: 'TRANSLATE', texts: ['Hello'] }, { id: 'extension-test', url }, () => assert.fail()), false);
  }
  assert.equal(app.listener({ type: 'TRANSLATE', texts: ['Hello'] }, { id: 'another-extension', url: 'https://udemy.com/' }, () => assert.fail()), false);
  assert.equal(app.calls, 0);
});
test('oversized requests and incomplete AI answers never enter cache', async () => {
  const app = setup();
  assert.equal((await app.send(['a'.repeat(6001)])).ok, false);
  assert.equal(app.calls, 0);
  app.context.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }] }) });
  assert.equal((await app.send(['Hello'])).ok, false);
  assert.equal(Object.keys(app.saved).filter(k => k.startsWith('translation:')).length, 0);
});
test('quota failures return useful errors without leaking response bodies or keys', async () => {
  const app = setup();
  app.context.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'test-secret' } }) });
  const result = await app.send(['Hello']);
  assert.equal(result.ok, false); assert.match(result.error, /429/); assert.doesNotMatch(result.error, /test-secret/);
});
const success = () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify([{ id: 0, text: 'မြန်မာ' }]) }] } }] }) });
const limited = (status = 429) => ({ ok: false, status, headers: { get: () => '90' }, json: async () => ({ error: { message: 'secret provider error' } }) });
test('quota rotates once to the next key and prefers the successful key afterwards', async () => {
  const app = setup({ apiKeys: ['key-a', 'key-b'], model: 'gemini-test' });
  const used = [];
  app.context.fetch = async (_, init) => { used.push(init.headers['x-goog-api-key']); return used.length === 1 ? limited() : success(); };
  const first = await app.send(['Hello']);
  assert.equal(first.ok, true); assert.equal(first.keyIndex, 1);
  assert.deepEqual(used, ['key-a', 'key-b']);
  assert.equal((await app.send(['Another'])).ok, true);
  assert.deepEqual(used, ['key-a', 'key-b', 'key-b']);
  assert.equal(Object.keys(app.saved.keyCooldowns).some(key => key.includes('key-a')), false);
  assert.ok(Object.values(app.saved.keyCooldowns)[0].until > app.now);
});
test('all-limited keys are tried at most once and cooldown survives a worker restart', async () => {
  const app = setup({ apiKeys: ['key-a', 'key-a', 'key-b'], model: 'gemini-test' });
  let calls = 0;
  app.context.fetch = async () => { calls++; return limited(); };
  const response = await app.send(['Hello']);
  assert.equal(response.ok, false); assert.equal(calls, 2);
  assert.match(response.error, /All saved keys/);
  const resumed = setup(app.saved, app.now);
  resumed.context.fetch = async () => { calls++; return success(); };
  assert.equal((await resumed.send(['Another'])).ok, false);
  assert.equal(calls, 2);
  for (const entry of Object.values(app.saved.keyCooldowns)) entry.until = 0;
  assert.equal((await resumed.send(['Another'])).ok, true);
  assert.equal(calls, 3);
});
test('rotation can be disabled and model/server/network errors do not burn through keys', async () => {
  for (const code of [404, 503, 'network', 'disabled']) {
    const app = setup({ apiKeys: ['key-a', 'key-b'], model: 'gemini-test', autoRotate: code !== 'disabled' });
    let calls = 0;
    app.context.fetch = async () => { calls++; if (code === 'network') throw new Error('network'); return limited(code === 'disabled' ? 429 : code); };
    assert.equal((await app.send(['Hello'])).ok, false);
    assert.equal(calls, 1);
  }
});
test('invalid keys fail over, while saved empty key lists do not revive a legacy key', async () => {
  const app = setup({ apiKeys: ['key-a', 'key-b'], model: 'gemini-test' });
  let calls = 0;
  app.context.fetch = async () => ++calls === 1 ? limited(403) : success();
  assert.equal((await app.send(['Hello'])).ok, true); assert.equal(calls, 2);
  const empty = setup({ apiKey: 'legacy-secret', apiKeys: [], model: 'gemini-test' });
  assert.equal((await empty.send(['Hello'])).ok, false); assert.equal(empty.calls, 0);
});
test('model discovery is popup-only and filters/paginates text generation models', async () => {
  const app = setup();
  assert.equal(app.listener({ type: 'LIST_MODELS' }, { id: 'extension-test', url: 'https://udemy.com/' }, () => assert.fail()), false);
  let page = 0;
  app.context.fetch = async url => ({ ok: true, json: async () => ++page === 1 ? {
    models: [{ name: 'models/gemini-text', displayName: 'Text', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-image', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-1', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next'
  } : { models: [{ name: 'models/gemini-other', supportedGenerationMethods: ['generateContent'] }] } });
  const result = await new Promise(resolve => app.listener({ type: 'LIST_MODELS' }, { id: 'extension-test', url: 'chrome-extension://extension-test/popup.html' }, resolve));
  assert.equal(result.ok, true); assert.equal(page, 2);
  assert.deepEqual(Array.from(result.models, model => model.id), ['gemini-other', 'gemini-text']);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});
test('subtitle preferences persist without exposing credentials to content scripts', async () => {
  const app = setup();
  const initial = await app.message({ type: 'GET_PREFERENCES' });
  assert.equal(initial.preferences.autoTranslate, true);
  assert.equal(initial.preferences.fontSize, 26);
  const changed = await app.message({ type: 'SET_PREFERENCES', preferences: { autoTranslate: false, fontSize: 36, fontColor: '#ffe066', verticalPosition: 75, apiKey: 'injected' } });
  assert.equal(changed.ok, true);
  assert.equal(changed.preferences.fontSize, 36);
  const reloaded = await app.message({ type: 'GET_PREFERENCES' });
  assert.equal(reloaded.preferences.autoTranslate, false);
  assert.equal(reloaded.preferences.fontColor, '#ffe066');
  assert.equal(reloaded.preferences.verticalPosition, 75);
  assert.equal(JSON.stringify(reloaded).includes('apiKey'), false);
  assert.equal(JSON.stringify(reloaded).includes('test-secret'), false);
  assert.equal(app.saved.apiKey, 'test-secret');
  assert.equal(app.calls, 0);
});
test('all keys hit quota before moving to a fallback, without overwriting the preferred model', async () => {
  const app = setup({ apiKeys: ['key-a', 'key-b'], model: 'gemini-preferred', autoModelFallback: true, fallbackModels: ['gemini-backup'] });
  const attempts = [];
  app.context.fetch = async (url, init) => {
    attempts.push([url.match(/models\/([^:]+):/)[1], init.headers['x-goog-api-key']]);
    return url.includes('gemini-preferred') ? limited() : success();
  };
  const result = await app.send(['Hello']);
  assert.equal(result.ok, true); assert.equal(result.model, 'gemini-backup'); assert.equal(result.fallback, true);
  assert.deepEqual(attempts, [['gemini-preferred', 'key-a'], ['gemini-preferred', 'key-b'], ['gemini-backup', 'key-a']]);
  assert.equal(app.saved.model, 'gemini-preferred');
  const repeated = await app.send(['Hello']);
  assert.equal(repeated.cached, true); assert.equal(repeated.model, 'gemini-backup');
  assert.equal(attempts.length, 3);
});
test('model fallback is bounded and disabled mode uses only the preferred model', async () => {
  for (const enabled of [true, false]) {
    const app = setup({ apiKeys: ['a', 'b'], model: 'gemini-main', autoModelFallback: enabled, fallbackModels: ['gemini-next', 'gemini-last'] });
    let calls = 0;
    app.context.fetch = async () => { calls++; return limited(); };
    const result = await app.send(['Hello']);
    assert.equal(result.ok, false); assert.equal(calls, enabled ? 6 : 2);
    assert.doesNotMatch(result.error, /key-a|key-b/);
  }
});
test('an unavailable backup is skipped after quota, but unavailable primary and network errors remain visible', async () => {
  const app = setup({ apiKeys: ['a'], model: 'gemini-main', autoModelFallback: true, fallbackModels: ['gemini-gone', 'gemini-working'] });
  app.context.fetch = async url => url.includes('gemini-main') ? limited() : url.includes('gemini-gone') ? limited(404) : success();
  assert.equal((await app.send(['Hello'])).model, 'gemini-working');
  for (const code of [404, 403, 'network']) {
    const blocked = setup({ apiKeys: ['a'], model: 'gemini-main', autoModelFallback: true, fallbackModels: ['gemini-next'] });
    let calls = 0;
    blocked.context.fetch = async () => { calls++; if (code === 'network') throw new Error('network'); return limited(code); };
    assert.equal((await blocked.send(['Hello'])).ok, false); assert.equal(calls, 1);
  }
});
test('each explicit model selection controls the actual endpoint and its own cache', async () => {
  const app = setup({ apiKeys: ['a'], model: 'gemini-selected-pro', autoModelFallback: false });
  const used = [];
  app.context.fetch = async url => { used.push(url); return success(); };
  const first = await app.send(['Hello']);
  assert.equal(first.model, 'gemini-selected-pro'); assert.match(used[0], /gemini-selected-pro:streamGenerateContent/);
  app.saved.model = 'gemini-other-pro';
  const second = await app.send(['Hello']);
  assert.equal(second.model, 'gemini-other-pro'); assert.equal(second.cached, false); assert.equal(used.length, 2);
  assert.equal(app.saved.model, 'gemini-other-pro');
});

test('every network attempt waits 30 seconds, including rotation, fallback and worker restart', async () => {
  const app = setup({ apiKeys: ['a', 'b'], model: 'gemini-main', autoModelFallback: true, fallbackModels: ['gemini-backup'] });
  const starts = [];
  app.context.fetch = async url => { starts.push(app.now); return url.includes('gemini-main') ? limited() : success(); };
  assert.equal((await app.send(['Hello'])).ok, true);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 30000);
  assert.ok(app.waits.every(wait => wait <= 10000));
  const resumed = setup(app.saved, app.now);
  let restartedAt;
  resumed.context.fetch = async () => { restartedAt = resumed.now; return success(); };
  assert.equal((await resumed.send(['Different'])).ok, true);
  assert.ok(restartedAt - starts.at(-1) >= 30000);
});

test('24-line batches are accepted and old 12-line caches are reused without waiting', async () => {
  const app = setup();
  const texts = Array.from({ length: 24 }, (_, i) => `Line ${i}`);
  let calls = 0;
  app.context.fetch = async (_, init) => {
    calls++;
    const items = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);
    return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(items.map(item => ({ id: item.id, text: 'မြန်မာ' }))) }] } }] }) };
  };
  assert.equal((await app.send(texts.slice(0, 12))).ok, true);
  assert.equal((await app.send(texts.slice(12))).ok, true);
  const waits = app.waits.length;
  const combined = await app.send(texts);
  assert.equal(combined.ok, true); assert.equal(combined.cached, true);
  assert.equal(combined.texts.length, 24); assert.equal(calls, 2);
  assert.equal(app.waits.length, waits);
  const fresh = texts.map(text => text + ' new');
  const result = await app.send(fresh);
  assert.equal(result.ok, true); assert.equal(result.texts.length, 24);
  assert.equal(calls, 3);
  assert.equal((await app.send([...fresh, '25th'])).ok, false);
  assert.equal(calls, 3);
});

test('streamed translation chunks are combined and cached only after a complete STOP', async () => {
  const app = setup();
  let endpoint;
  app.context.fetch = async url => {
    endpoint = url;
    return { ok: true, json: async () => [
      { candidates: [{ content: { parts: [{ text: 'internal', thought: true }, { text: '[{"id":0,' }] } }] },
      { candidates: [{ content: { parts: [{ text: '"text":"မြန်မာ"}]' }] }, finishReason: 'STOP' }] }
    ] };
  };
  const result = await app.send(['Hello']);
  assert.equal(result.ok, true); assert.equal(result.texts[0], 'မြန်မာ');
  assert.match(endpoint, /:streamGenerateContent$/);
  assert.equal((await app.send(['Hello'])).cached, true);
  app.context.fetch = async () => ({ ok: true, json: async () => [{ candidates: [{ content: { parts: [{ text: '[{"id":0,"text":"partial"}]' }] } }] }] });
  assert.equal((await app.send(['Incomplete'])).ok, false);
  assert.equal(Object.keys(app.saved).filter(key => key.startsWith('translation:')).length, 1);
});

test('90-second deadline starts after rate-limit waiting and timeout differs from network failure', async () => {
  const app = setup();
  const createdAt = [];
  app.context.AbortSignal = { timeout(milliseconds) {
    assert.equal(milliseconds, 90000);
    createdAt.push(app.now);
    return { aborted: false };
  } };
  const first = await app.send(['Hello']);
  assert.equal(first.ok, true);
  assert.equal((await app.send(['Another'])).ok, true);
  assert.equal(createdAt[1] - createdAt[0], 30000);
  app.context.fetch = async () => { const error = new Error('private'); error.name = 'TimeoutError'; throw error; };
  const timeout = await app.send(['Timeout']);
  assert.match(timeout.error, /90 seconds/);
  app.context.fetch = async () => { throw new TypeError('private'); };
  const network = await app.send(['Offline']);
  assert.match(network.error, /internet connection/);
  assert.doesNotMatch(network.error, /private|90 seconds/);
  app.context.fetch = async () => ({ ok: true, json: async () => { const error = new Error('private'); error.name = 'AbortError'; throw error; } });
  assert.match((await app.send(['Body timeout'])).error, /90 seconds/);
});

test('timeout skips remaining keys and falls back in order with cache and preferred model preserved', async () => {
  const app = setup({ apiKeys: ['a', 'b'], model: 'gemini-main', autoModelFallback: true, fallbackModels: ['gemini-next', 'gemini-last'] });
  const attempts = [];
  app.context.fetch = async (url, init) => {
    attempts.push({ url, key: init.headers['x-goog-api-key'], at: app.now });
    if (!url.includes('gemini-last')) { const error = new Error('private'); error.name = 'TimeoutError'; throw error; }
    return success();
  };
  const result = await app.send(['Hello']);
  assert.equal(result.ok, true); assert.equal(result.model, 'gemini-last'); assert.equal(result.fallback, true);
  assert.equal(attempts.length, 3); assert.ok(attempts.every(attempt => attempt.key === 'a'));
  assert.match(attempts[0].url, /gemini-main:/); assert.match(attempts[1].url, /gemini-next:/);
  for (let i = 1; i < attempts.length; i++) assert.ok(attempts[i].at - attempts[i - 1].at >= 30000);
  assert.equal(app.saved.model, 'gemini-main');
  // Only the successful model has a cache entry; failed/partial results are never saved.
  assert.equal(Object.keys(app.saved).filter(key => key.startsWith('translation:')).length, 1);
  const cached = await app.send(['Hello']);
  assert.equal(cached.ok, true); assert.equal(cached.cached, true); assert.equal(cached.model, 'gemini-last');
});

test('all model timeouts stop after one attempt per model; disabling fallback stops after the primary', async () => {
  for (const enabled of [true, false]) {
    const app = setup({ apiKeys: ['a', 'b'], model: 'gemini-main', autoModelFallback: enabled, fallbackModels: ['gemini-next', 'gemini-last'] });
    let calls = 0;
    app.context.fetch = async () => { calls++; const error = new Error('private'); error.name = 'TimeoutError'; throw error; };
    const result = await app.send(['Hello']);
    assert.equal(result.ok, false); assert.equal(calls, enabled ? 3 : 1);
    assert.match(result.error, enabled ? /All configured models.*timed out/ : /90 seconds/);
    assert.doesNotMatch(result.error, /private/);
    assert.equal(Object.keys(app.saved).filter(key => key.startsWith('translation:')).length, 0);
  }
});

test('timeout while reading the body also triggers the next model', async () => {
  const app = setup({ apiKeys: ['a'], model: 'gemini-main', autoModelFallback: true, fallbackModels: ['gemini-next'] });
  app.context.fetch = async url => url.includes('gemini-main') ? { ok: true, json: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; } } : success();
  const result = await app.send(['Hello']);
  assert.equal(result.ok, true); assert.equal(result.model, 'gemini-next');
});

test('timed-out models stay paused across batches and worker restart, then preferred model resumes after ten minutes', async () => {
  const app = setup({ apiKeys: ['a'], model: 'gemini-main', autoModelFallback: true, fallbackModels: ['gemini-next', 'gemini-last'] });
  const attempts = [];
  app.context.fetch = async url => {
    attempts.push(url);
    if (!url.includes('gemini-last')) { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; }
    return success();
  };
  assert.equal((await app.send(['First batch'])).model, 'gemini-last');
  assert.equal(attempts.length, 3);
  assert.equal((await app.send(['Second batch'])).model, 'gemini-last');
  assert.equal(attempts.length, 4); assert.match(attempts[3], /gemini-last:/);
  const cached = await app.send(['Second batch']);
  assert.equal(cached.cached, true); assert.equal(attempts.length, 4);
  const resumed = setup(app.saved, app.now);
  const restarted = [];
  resumed.context.fetch = async url => { restarted.push(url); return success(); };
  assert.equal((await resumed.send(['Third batch'])).model, 'gemini-last');
  assert.equal(restarted.length, 1);
  const expired = setup(app.saved, app.now + 600001);
  expired.context.fetch = async url => { assert.match(url, /gemini-main:/); return success(); };
  assert.equal((await expired.send(['After cooldown'])).model, 'gemini-main');
  assert.equal(expired.saved.model, 'gemini-main');
});

test('changing the model policy or disabling fallback ignores earlier routing preference', async () => {
  for (const change of ['primary', 'fallbacks', 'disabled']) {
    const saved = { apiKeys: ['a'], model: 'gemini-main', autoModelFallback: true, fallbackModels: ['gemini-next'] };
    const app = setup(saved);
    app.context.fetch = async url => {
      if (url.includes('gemini-main')) { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; }
      return success();
    };
    assert.equal((await app.send(['First'])).model, 'gemini-next');
    if (change === 'primary') saved.model = 'gemini-selected';
    if (change === 'fallbacks') saved.fallbackModels = ['gemini-other'];
    if (change === 'disabled') saved.autoModelFallback = false;
    app.context.fetch = async url => { assert.ok(url.includes(saved.model + ':')); return success(); };
    assert.equal((await app.send(['Next'])).model, saved.model);
  }
});

test('all paused models stop without new network requests and saved cache remains usable', async () => {
  const app = setup({ apiKeys: ['a'], model: 'gemini-main', autoModelFallback: true, fallbackModels: ['gemini-next'] });
  assert.equal((await app.send(['Saved earlier'])).ok, true);
  let calls = 0;
  app.context.fetch = async () => { calls++; const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; };
  assert.equal((await app.send(['First'])).ok, false); assert.equal(calls, 2);
  const blocked = await app.send(['Next']);
  assert.equal(blocked.ok, false); assert.match(blocked.error, /paused after a timeout/); assert.equal(calls, 2);
  const cached = await app.send(['Saved earlier']);
  assert.equal(cached.ok, true); assert.equal(cached.cached, true); assert.equal(calls, 2);
});
