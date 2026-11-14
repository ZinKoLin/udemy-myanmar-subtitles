const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../core.js');
globalThis.SubtitleCore = core;
const browser = require('../browser-core.js');
const cues = [{ start: 0.125, end: 2, text: 'Hello' }, { start: 3, end: 5.75, text: 'Keep the code: npm test' }];
const reply = (id, text = 'မင်္ဂလာပါ') => `BEGIN_${id}\n\`\`\`srt\n1\n00:00:00,125 --> 00:00:02,000\n${text}\n\n2\n00:00:03,000 --> 00:00:05,750\nnpm test ကို သုံးပါ\n\`\`\`\nEND_${id}`;
test('complete SRT roundtrip preserves millisecond timing, gaps and all cues', () => {
  assert.deepEqual(core.parseSubtitles(browser.toSrt(cues)), cues);
  assert.equal(browser.timestamp(36000.001), '10:00:00,001');
  assert.equal(browser.parseReply(reply('job'), 'job', cues).length, 2);
  assert.throws(() => browser.toSrt([{ text: 'Untimed transcript', transcript: true }]));
});
test('partial replies, wrong job, duplicate IDs, blank cues and timestamp edits fail closed', () => {
  for (const raw of [reply('other'), reply('job').replace('END_job', ''), reply('job').replace('00:00:05,750', '00:00:05,751'), reply('job').replace('\n2\n', '\n1\n'), reply('job', ''), reply('job').replace(/\n\n2[\s\S]*?```/, '\n```')]) {
    assert.throws(() => browser.parseReply(raw, 'job', cues));
  }
});
function setup(saved = { geminiAccountIndex: 2, geminiAccountEmail: 'pro@example.com' }) {
  let created = 0, calls = 0;
  const context = vm.createContext({
    SubtitleCore: core, BrowserSubtitleCore: browser, ready: Promise.resolve(), URL, Date, crypto: globalThis.crypto,
    digest: async value => require('node:crypto').createHash('sha256').update(value).digest('hex'),
    AbortSignal,
    fetch: async () => { calls++; throw new Error('No network allowed'); },
    chrome: {
      runtime: { id: 'test' },
      storage: { local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(saved[k])])); }, async set(data) { Object.assign(saved, structuredClone(data)); } } },
      permissions: { async contains() { return true; } },
      tabs: { async create(options) { created++; assert.match(options.url, /^https:\/\/gemini.google.com\/u\/2\/app(?:\/[^#]+)?#udemy-srt=/); return { id: 99 }; }, async get(id) { return { id, url: saved.geminiBrowserSession?.chatUrl || 'https://gemini.google.com/u/2/app' }; }, async sendMessage() { return { ok: true }; }, async reload() {} }
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../n8n-client.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../browser-background.js'), 'utf8'), context);
  const udemy = { id: 'test', tab: { id: 1 }, url: 'https://www.udemy.com/course/test/learn/lecture/1' };
  const gemini = { id: 'test', tab: { id: 99 }, url: 'https://gemini.google.com/u/2/app/chat' };
  return { saved, udemy, gemini, context, get created() { return created; }, get calls() { return calls; },
    send(message, sender = udemy) { return new Promise(resolve => { if (!context.browserMessage(message, sender, resolve)) resolve(false); }); }
  };
}
test('whole lecture goes as one SRT job, survives worker restart, validates and caches without API', async () => {
  const app = setup();
  assert.equal((await app.send({ type: 'GET_PROVIDER' })).provider, 'browser');
  const started = await app.send({ type: 'WEB_START', cues });
  assert.equal(app.created, 1);
  let task = await app.send({ type: 'WEB_TASK' }, app.gemini);
  assert.equal(core.parseSubtitles(task.srt).length, 2); assert.match(task.prompt, /ENTIRE/);
  assert.equal((await app.send({ type: 'WEB_SENT', id: started.id }, app.gemini)).claimed, true);
  assert.notEqual((await app.send({ type: 'WEB_SENT', id: started.id }, app.gemini)).claimed, true);
  const restarted = setup(app.saved);
  task = await restarted.send({ type: 'WEB_TASK' }, restarted.gemini);
  assert.equal(task.state, 'waiting'); assert.equal(task.srt, undefined);
  const invalid = await restarted.send({ type: 'WEB_RESULT', id: started.id, raw: reply(started.id).replace('00:00:05,750', '00:00:06,000') }, restarted.gemini);
  assert.equal(invalid.ok, false); assert.equal(restarted.saved.browserSubtitleJob.state, 'waiting');
  assert.equal((await restarted.send({ type: 'WEB_RESULT', id: started.id, raw: reply(started.id) }, restarted.gemini)).done, true);
  const status = await restarted.send({ type: 'WEB_STATUS', id: started.id });
  assert.equal(status.state, 'done'); assert.equal(status.texts.length, 2);
  assert.equal((await restarted.send({ type: 'WEB_START', cues })).cached, true);
  assert.equal(restarted.created, 0); assert.equal(app.calls + restarted.calls, 0);
});
test('tab ownership, sender domains and cancellation block stale results after lecture navigation', async () => {
  const app = setup();
  const started = await app.send({ type: 'WEB_START', cues });
  assert.equal((await app.send({ type: 'WEB_TASK' }, { ...app.gemini, tab: { id: 100 } })).idle, true);
  assert.equal(await app.send({ type: 'WEB_RESULT', id: started.id, raw: reply(started.id) }), false);
  assert.equal(await app.send({ type: 'WEB_START', cues }, { ...app.udemy, url: 'https://udemy.com.evil.test/' }), false);
  assert.equal((await app.send({ type: 'WEB_STATUS', id: started.id }, { ...app.udemy, tab: { id: 2 } })).ok, false);
  await app.send({ type: 'WEB_CANCEL', id: started.id }, { ...app.udemy, url: 'https://www.udemy.com/course/test/learn/lecture/2' });
  assert.equal(app.saved.browserSubtitleJob.state, 'cancelled');
  await app.send({ type: 'WEB_RESULT', id: started.id, raw: reply(started.id) }, app.gemini);
  assert.equal(Object.keys(app.saved).filter(k => k.startsWith('translation:')).length, 0);
});
test('caption fetch accepts only Udemy CDN and API mode never starts a browser job', async () => {
  const app = setup({ translationProvider: 'api' });
  assert.equal((await app.send({ type: 'WEB_START', cues })).ok, false); assert.equal(app.created, 0);
  for (const url of ['https://example.com/a.vtt', 'http://cdn.udemycdn.com/a.vtt', 'https://udemycdn.com.evil.test/a.vtt', 'https://user:pass@cdn.udemycdn.com/a.vtt']) {
    assert.equal((await app.send({ type: 'FETCH_CAPTION', url })).ok, false);
  }
  assert.equal(app.calls, 0);
});
test('a Pro account must be explicitly configured before opening any Gemini tab', async () => {
  const app = setup({});
  const result = await app.send({ type: 'WEB_START', cues });
  assert.equal(result.ok, false); assert.match(result.error, /Pro account number and email/); assert.equal(app.created, 0);
});
test('original API and browser methods can be selected without deleting saved credentials or model preferences', async () => {
  const app = setup({ translationProvider: 'browser', apiKeys: ['saved-key'], model: 'saved-model', geminiAccountEmail: 'pro@example.com', geminiAccountIndex: 2 });
  assert.equal((await app.send({ type: 'SET_PROVIDER', provider: 'api' })).provider, 'api');
  assert.equal((await app.send({ type: 'GET_PROVIDER' })).provider, 'api');
  assert.deepEqual(app.saved.apiKeys, ['saved-key']); assert.equal(app.saved.model, 'saved-model');
  assert.equal((await app.send({ type: 'SET_PROVIDER', provider: 'browser' })).provider, 'browser');
  assert.equal(app.saved.geminiAccountEmail, 'pro@example.com');
  assert.equal((await app.send({ type: 'SET_PROVIDER', provider: 'unknown' })).ok, false);
  assert.equal(await app.send({ type: 'SET_PROVIDER', provider: 'api' }, app.gemini), false);
});
test('later lectures reuse the same dedicated Gemini conversation, including reopening its saved URL', async () => {
  const app = setup();
  const first = await app.send({ type: 'WEB_START', cues });
  await app.send({ type: 'WEB_TASK' }, app.gemini);
  await app.send({ type: 'WEB_SENT', id: first.id }, app.gemini);
  await app.send({ type: 'WEB_RESULT', id: first.id, raw: reply(first.id) }, app.gemini);
  assert.equal(app.saved.geminiBrowserSession.chatUrl, app.gemini.url);
  const second = await app.send({ type: 'WEB_START', cues: cues.map(cue => ({ ...cue, text: cue.text + ' next' })) });
  assert.equal(second.ok, true); assert.equal(app.created, 1);
  await app.send({ type: 'WEB_CANCEL', id: second.id });
  app.context.chrome.tabs.get = async () => { throw new Error('closed'); };
  const reopened = await app.send({ type: 'WEB_START', cues: cues.map(cue => ({ ...cue, text: cue.text + ' another' })) });
  assert.equal(reopened.ok, true); assert.equal(app.created, 2);
});
test('n8n sends the full SRT to the server and validates the returned job without opening local Gemini', async () => {
  const app = setup({ translationProvider: 'n8n', n8nUrl: 'https://n8n.example.test/webhook/udemy-srt', n8nToken: 'a'.repeat(64) });
  const commands = [];
  app.context.fetch = async (url, init) => {
    assert.equal(url, app.saved.n8nUrl); assert.equal(init.headers['X-Udemy-Token'], app.saved.n8nToken);
    const input = JSON.parse(init.body); commands.push(input);
    return { ok: true, text: async () => JSON.stringify({ ok: true, id: input.id, state: input.action === 'status' ? 'done' : 'ready', raw: input.action === 'status' ? reply(input.id) : undefined }) };
  };
  const started = await app.send({ type: 'WEB_START', cues });
  assert.equal(started.ok, true); assert.equal(app.created, 0);
  assert.equal(commands[0].action, 'start'); assert.equal(core.parseSubtitles(commands[0].srt).length, 2);
  const done = await app.send({ type: 'WEB_STATUS', id: started.id });
  assert.equal(done.state, 'done'); assert.equal(done.texts.length, 2); assert.equal(app.created, 0);
  assert.equal((await app.send({ type: 'WEB_TASK' }, app.gemini)).idle, true);
});
test('an offline server cannot block switching back to a local translation method', async () => {
  const app = setup({ translationProvider: 'n8n', geminiAccountIndex: 2, geminiAccountEmail: 'pro@example.com', n8nUrl: 'https://n8n.example.test/webhook/udemy-srt', n8nToken: 'a'.repeat(64) });
  app.context.fetch = async (_, init) => { const input = JSON.parse(init.body); return { ok: true, text: async () => JSON.stringify({ ok: true, id: input.id, state: 'ready' }) }; };
  await app.send({ type: 'WEB_START', cues });
  app.context.fetch = async () => { throw new Error('offline'); };
  await app.send({ type: 'SET_PROVIDER', provider: 'browser' });
  const local = await app.send({ type: 'WEB_START', cues });
  assert.equal(local.ok, true); assert.equal(app.created, 1); assert.equal(app.saved.browserSubtitleJob.mode, 'browser');
});
