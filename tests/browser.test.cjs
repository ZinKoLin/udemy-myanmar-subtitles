const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../core.js');
globalThis.SubtitleCore = core;
const browser = require('../browser-core.js');
const cues = [{ start: 0.125, end: 2, text: 'Hello' }, { start: 3, end: 5.75, text: 'Keep the code: npm test' }];
const reply = (id, text = 'မင်္ဂလာပါ') => `BEGIN_${id}\n\`\`\`srt\n1\n00:00:00,125 --> 00:00:02,000\n${text}\n\n2\n00:00:03,000 --> 00:00:05,750\nnpm test ကို သုံးပါ\n\`\`\`\nEND_${id}`;
const jsonReply = (id) => `BEGIN_${id}\n${JSON.stringify([{id:'C000001',text:'မင်္ဂလာပါ'},{id:'C000002',text:'npm test ကို သုံးပါ'}])}\nEND_${id}`;

test('Coursera full SRT jobs use the configured Pro chat and retain owner validation', async () => {
  const app = setup();
  const coursera = { ...app.udemy, url: 'https://www.coursera.org/learn/test/lecture/one/introduction' };
  assert.equal((await app.send({ type: 'GET_PROVIDER' }, coursera)).provider, 'browser');
  const started = await app.send({ type: 'WEB_START', cues }, coursera); assert.ok(started.id);
  const task = await app.send({ type: 'WEB_TASK' }, app.gemini); assert.equal(core.parseSubtitles(task.srt).length, 2);
  await app.send({ type: 'WEB_SENT', id: started.id }, app.gemini);
  assert.equal((await app.send({ type: 'WEB_RESULT', id: started.id, raw: jsonReply(started.id) }, app.gemini)).done, true);
  assert.equal((await app.send({ type: 'WEB_STATUS', id: started.id }, coursera)).state, 'done');
  assert.equal((await app.send({ type: 'WEB_STATUS', id: started.id }, app.udemy)).ok, false);
  for (const url of ['https://www.coursera.org.evil.test/', 'http://www.coursera.org/', 'https://www.coursera.org:8443/']) assert.equal(await app.send({ type: 'GET_PROVIDER' }, { ...coursera, url }), false);
  assert.equal(await app.send({ type: 'FETCH_CAPTION', url: 'https://vtt-cf.udemycdn.com/file.vtt' }, coursera), false);
});
test('complete SRT roundtrip preserves millisecond timing, gaps and all cues', () => {
  assert.deepEqual(core.parseSubtitles(browser.toSrt(cues)), cues);
  assert.equal(browser.timestamp(36000.001), '10:00:00,001');
  assert.equal(browser.parseReply(reply('job'), 'job', cues).length, 2);
  assert.throws(() => browser.toSrt([{ text: 'Untimed transcript', transcript: true }]));
});
test('partial replies, wrong job, duplicate IDs, blank cues fail closed', () => {
  for (const raw of [reply('other'), reply('job').replace('END_job', ''), reply('job').replace('\n2\n', '\n1\n'), reply('job', ''), reply('job').replace(/\n\n2[\s\S]*?```/, '\n```')]) {
    assert.throws(() => browser.parseReply(raw, 'job', cues));
  }
});

test('hundreds of cues accept harmless extra zero padding but still reject omitted, added and duplicate numeric IDs', () => {
  const original = Array.from({length:114}, (_, i) => ({ start:i * 2 + 0.125, end:i * 2 + 1.75, text:'English ' + (i+1) }));
  const items = original.map((_, i) => ({id:'C' + String(i+1).padStart(i >= 99 ? 7 : 6, '0'),text:'မြန်မာ ' + (i+1)}));
  const raw = values => `BEGIN_many\n${JSON.stringify(values)}\nEND_many`;
  const result = browser.translatedCues(raw(items.slice().reverse()), 'many', original, true);
  assert.equal(result.length, 114); assert.equal(result[99].text,'မြန်မာ 100');
  assert.deepEqual(result.map(c=>[c.start,c.end]),original.map(c=>[c.start,c.end]));
  assert.throws(()=>browser.translatedCues(raw(items.slice(1)), 'many',original,true));
  assert.throws(()=>browser.translatedCues(raw([...items,{id:'C000115',text:'extra'}]), 'many',original,true));
  const duplicate = items.map(x=>({...x})); duplicate[100].id='C000100';
  assert.throws(()=>browser.translatedCues(raw(duplicate),'many',original,true));
  duplicate[100].id='C000115'; assert.throws(()=>browser.translatedCues(raw(duplicate),'many',original,true));
});
function setup(saved = { geminiAccountIndex: 2, geminiAccountEmail: 'pro@example.com' }) {
  let created = 0, calls = 0, updated;
  const createdUrls = [];
  const context = vm.createContext({
    SubtitleCore: core, BrowserSubtitleCore: browser, ready: Promise.resolve(), URL, Date, TextEncoder, crypto: globalThis.crypto,
    digest: async value => require('node:crypto').createHash('sha256').update(value).digest('hex'),
    AbortSignal,
    fetch: async () => { calls++; throw new Error('No network allowed'); },
    chrome: {
      runtime: { id: 'test' },
      storage: { local: { async get(keys) { if (keys === null) return structuredClone(saved); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(saved[k])])); }, async set(data) { Object.assign(saved, structuredClone(data)); }, async remove(keys) { for (const key of keys) delete saved[key]; } } },
      permissions: { async contains() { return true; } },
      tabs: { onUpdated: { addListener(fn) { updated = fn; } }, async query() { return [{ id: 1, url: 'https://www.udemy.com/course/test/learn/lecture/1' }]; }, async create(options) { created++; createdUrls.push(options.url); assert.match(options.url, /^https:\/\/gemini.google.com\/u\/2\/app(?:\/[^#]+)?#udemy-srt=/); return { id: 99 }; }, async get(id) { return { id, url: saved.geminiBrowserSession?.chatUrl || 'https://gemini.google.com/u/2/app' }; }, async sendMessage() { return { ok: true }; }, async reload() {} }
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../cache-store.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../n8n-client.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../browser-background.js'), 'utf8'), context);
  const udemy = { id: 'test', tab: { id: 1 }, url: 'https://www.udemy.com/course/test/learn/lecture/1' };
  const gemini = { id: 'test', tab: { id: 99 }, url: 'https://gemini.google.com/u/2/app/chat' };
  return { saved, udemy, gemini, context, createdUrls, async tabUrlChanged(id,url) { updated(id,{url}); await vm.runInContext('webWrites',context); }, get created() { return created; }, get calls() { return calls; },
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
  const invalid = await restarted.send({ type: 'WEB_RESULT', id: started.id, raw: reply(started.id).replace('\n2\n', '\n1\n') }, restarted.gemini);
  assert.equal(invalid.repair, true); assert.equal(restarted.saved.browserSubtitleJob.state, 'repair-ready');
  const repairTask = await restarted.send({type:'WEB_TASK'}, restarted.gemini);
  assert.match(repairTask.repairPrompt, /SOURCE_FRAGMENTS/);
  assert.equal((await restarted.send({type:'WEB_REPAIR_SENT',id:started.id},restarted.gemini)).claimed,true);
  assert.equal((await restarted.send({ type: 'WEB_RESULT', id: started.id, raw: jsonReply(repairTask.responseId) }, restarted.gemini)).done, true);
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
  app.context.chrome.tabs.get = async id => ({id,url:app.gemini.url});
  await app.send({ type: 'WEB_TASK' }, {...app.gemini,url:'https://gemini.google.com/u/2/app'});
  await app.send({ type: 'WEB_SENT', id: first.id }, app.gemini);
  await app.send({ type: 'WEB_RESULT', id: first.id, raw: jsonReply(first.id) }, app.gemini);
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

test('Hydrogen Medium defaults, model changes isolate cache and late replies cannot replace the new job', async () => {
  const app = setup();
  assert.equal((await app.send({ type: 'GET_PROVIDER' })).browserModel, 'hydrogen-medium');
  const first = await app.send({ type: 'WEB_START', cues });
  assert.equal((await app.send({ type: 'WEB_TASK' }, app.gemini)).browserModel, 'hydrogen-medium');
  await app.send({ type: 'WEB_SENT', id: first.id }, app.gemini);
  await app.send({ type: 'WEB_RESULT', id: first.id, raw: jsonReply(first.id) }, app.gemini);
  assert.equal((await app.send({ type: 'SET_BROWSER_MODEL', model: 'flash-lite' })).browserModel, 'flash-lite');
  const next = await app.send({ type: 'WEB_START', cues });
  assert.equal(next.cached, undefined); assert.notEqual(next.id, first.id);
  assert.equal((await app.send({ type: 'WEB_TASK' }, app.gemini)).browserModel, 'flash-lite');
  assert.equal((await app.send({ type: 'WEB_RESULT', id: first.id, raw: jsonReply(first.id) }, app.gemini)).ok, false);
  assert.equal((await app.send({ type: 'SET_BROWSER_MODEL', model: 'bad' })).ok, false);
  assert.equal(await app.send({ type: 'SET_BROWSER_MODEL', model: 'current' }, app.gemini), false);
});
test('manual Gemini model mode never reuses translations from a previous manually chosen model', async () => {
  const app = setup();
  await app.send({ type: 'SET_BROWSER_MODEL', model: 'current' });
  const first = await app.send({ type: 'WEB_START', cues });
  await app.send({ type: 'WEB_SENT', id: first.id }, app.gemini);
  await app.send({ type: 'WEB_RESULT', id: first.id, raw: jsonReply(first.id) }, app.gemini);
  const next = await app.send({ type: 'WEB_START', cues });
  assert.notEqual(next.id, first.id); assert.equal(next.cached, undefined);
});

test('model timestamp drift and reversed times cannot change original millisecond cue timing or text order', () => {
  const raw = reply('job').replace('00:00:00,125 --> 00:00:02,000', '00:10:00,000 --> 00:00:00,000').replace('00:00:03,000 --> 00:00:05,750', '00:00:01,000 --> 00:00:01,001');
  const translated = browser.translatedCues(raw, 'job', cues);
  assert.deepEqual(translated.map(({start, end}) => ({start, end})), cues.map(({start, end}) => ({start, end})));
  assert.deepEqual(translated.map(c => c.text), ['မင်္ဂလာပါ', 'npm test ကို သုံးပါ']);
  assert.deepEqual(core.parseSubtitles(browser.toSrt(translated)), translated);
  assert.equal(cues[0].text, 'Hello');
});
test('immutable JSON IDs allow reordering, preserve original timing and reject missing or duplicate IDs', () => {
  const marker = 'job';
  const wrap = items => `BEGIN_${marker}\n\`\`\`json\n${JSON.stringify(items)}\n\`\`\`\nEND_${marker}`;
  const items = [{id:'C000002',text:'ဒုတိယ'},{id:'C000001',text:'ပထမ'}];
  const translated = browser.translatedCues(wrap(items),marker,cues,true);
  assert.deepEqual(translated, [{...cues[0],text:'ပထမ'},{...cues[1],text:'ဒုတိယ'}]);
  for (const invalid of [items.slice(1), [items[0],items[0]], [items[0],{id:'C000003',text:'wrong'}]]) assert.throws(()=>browser.parseReply(wrap(invalid),marker,cues,true));
  assert.throws(()=>browser.parseReply(reply(marker),marker,cues,true),/immutable/);
  assert.match(browser.taggedSrt(cues),/\[C000001\] Hello/);
});
test('automatic correction has distinct markers, one claim, survives worker restart and stops after one attempt', async () => {
  const app = setup(); const started = await app.send({type:'WEB_START',cues});
  await app.send({type:'WEB_SENT',id:started.id},app.gemini);
  const bad = `BEGIN_${started.id}\n[]\nEND_${started.id}`;
  assert.equal((await app.send({type:'WEB_RESULT',id:started.id,raw:bad},app.gemini)).repair,true);
  assert.equal(Object.keys(app.saved).filter(k=>k.startsWith('translation:')).length,0);
  const resumed = setup(app.saved); const task = await resumed.send({type:'WEB_TASK'},resumed.gemini);
  assert.equal(task.state,'repair-ready'); assert.notEqual(task.responseId,task.id);
  assert.match(task.repairPrompt,/C000002/); assert.match(task.repairPrompt,/Keep the code/);
  assert.equal((await resumed.send({type:'WEB_REPAIR_SENT',id:task.id},resumed.gemini)).claimed,true);
  assert.notEqual((await resumed.send({type:'WEB_REPAIR_SENT',id:task.id},resumed.gemini)).claimed,true);
  const failed = await resumed.send({type:'WEB_RESULT',id:task.id,raw:`BEGIN_${task.responseId}\n[]\nEND_${task.responseId}`},resumed.gemini);
  assert.equal(failed.ok,false); assert.match(failed.error,/တစ်ကြိမ်/);
  await resumed.send({type:'WEB_ERROR',id:task.id,error:failed.error},resumed.gemini);
  assert.equal(resumed.saved.browserSubtitleJob.state,'error'); assert.equal(resumed.saved.browserSubtitleJob.repairs,1);
});


test('delivery leases, bounded sends and retries survive worker restart', async () => {
 let app = setup(); const {id} = await app.send({type:'WEB_START',cues});
 await app.send({type:'WEB_SENT',id,clientId:'first'},app.gemini);
 let task = await app.send({type:'WEB_TASK'},app.gemini);
 assert.equal(task.recovery,true); assert.equal(core.parseSubtitles(task.recoverySrt).length,2);
 assert.equal(task.ownedDrafts.length,1); assert.match(task.ownedDrafts[0].hash,/^[a-f0-9]{64}$/);
 const delivery = (stage,clientId='first') => app.send({type:'WEB_DELIVERY',id,responseId:id,stage,clientId},app.gemini);
 assert.equal((await delivery('send','second')).busy,true);
 assert.equal((await delivery('send')).claimed,true);
 app=setup(app.saved); assert.equal((await delivery('send')).claimed,true);
 assert.equal((await delivery('send')).ok,false);
 assert.equal((await delivery('ack','second')).claimed,true);
 task=await app.send({type:'WEB_TASK'},app.gemini); assert.equal(task.recoverySrt,undefined); assert.equal(task.delivery.phase,'submitted');
 assert.equal((await delivery('send')).submitted,true);
 const retry = responseId => app.send({type:'WEB_RETRY',id,responseId},app.gemini);
 assert.equal((await retry('other')).ok,false); assert.equal((await retry(id)).attempt,1);
 assert.equal((await retry(id)).claimed,false);
 app.saved.browserSubtitleJob.retryAt -= 31000; app=setup(app.saved);
 assert.equal((await retry(id)).attempt,2);
 app.saved.browserSubtitleJob.retryAt -= 31000; app=setup(app.saved);
 assert.equal((await retry(id)).ok,false); assert.equal(app.saved.browserSubtitleJob.errorRetries,2);
});


test('restarting a pending lecture wakes its existing Gemini adapter without creating another job', async () => {
 const app=setup(); const first=await app.send({type:'WEB_START',cues}); let wakes=0,reloads=0;
 app.context.chrome.tabs.sendMessage=async()=>{wakes++;throw new Error('old context');};
 app.context.chrome.tabs.reload=async()=>{reloads++;};
 const resumed=await app.send({type:'WEB_START',cues});
 assert.equal(resumed.id,first.id); assert.equal(app.created,1); assert.equal(wakes,1); assert.equal(reloads,1);
});


test('a conversation URL assigned after polling stops still reuses the reserved account tab', async () => {
 const app=setup(); const first=await app.send({type:'WEB_START',cues});
 await app.send({type:'WEB_SENT',id:first.id},app.gemini);
 await app.send({type:'WEB_RESULT',id:first.id,raw:jsonReply(first.id)},app.gemini);
 app.context.chrome.tabs.get=async id=>({id,url:'https://gemini.google.com/u/2/app/late-conversation'});
 const second=await app.send({type:'WEB_START',cues:cues.map(c=>({...c,text:c.text+' next'}))});
 assert.equal(second.ok,true); assert.equal(app.created,1); assert.equal(app.saved.geminiBrowserSession.chatUrl,'https://gemini.google.com/u/2/app/late-conversation');
});


test('a pinned translation conversation survives New chat in its old tab and worker restart', async () => {
 const saved={geminiAccountIndex:2,geminiAccountEmail:'pro@example.com',geminiBrowserSession:{tabId:99,accountIndex:2,email:'pro@example.com',chatUrl:'https://gemini.google.com/u/2/app/pinned-chat'}};
 const app=setup(saved);
 app.context.chrome.tabs.get=async id=>({id,url:'https://gemini.google.com/u/2/app/unrelated-chat'});
 const first=await app.send({type:'WEB_START',cues}); assert.equal(first.ok,true);
 assert.match(app.createdUrls[0],/^https:\/\/gemini.google.com\/u\/2\/app\/pinned-chat#udemy-srt=/);
 await app.send({type:'WEB_TASK'},app.gemini);
 assert.equal(saved.geminiBrowserSession.chatUrl,'https://gemini.google.com/u/2/app/pinned-chat');
 await app.send({type:'WEB_CANCEL',id:first.id});
 const resumed=setup(saved);resumed.context.chrome.tabs.get=async()=>{throw new Error('closed');};
 await resumed.send({type:'WEB_START',cues:cues.map(c=>({...c,text:c.text+' next'}))});
 assert.match(resumed.createdUrls[0],/app\/pinned-chat#udemy-srt=/);
});

test('late conversation assignment is saved after completion and never overwritten by base or other chats', async () => {
 const app=setup(); const {id}=await app.send({type:'WEB_START',cues});
 await app.send({type:'WEB_SENT',id},app.gemini);
 await app.send({type:'WEB_RESULT',id,raw:jsonReply(id)},app.gemini);
 await app.tabUrlChanged(99,'https://gemini.google.com/u/2/app/late-chat');
 assert.equal(app.saved.geminiBrowserSession.chatUrl,'https://gemini.google.com/u/2/app/late-chat');
 for(const url of ['https://gemini.google.com/u/2/app','https://gemini.google.com/u/2/app/other-chat','https://evil.test/u/2/app/late-chat']) await app.tabUrlChanged(99,url);
 assert.equal(app.saved.geminiBrowserSession.chatUrl,'https://gemini.google.com/u/2/app/late-chat');
});

test('foreign accounts, malformed paths and foreign tabs cannot pin the translation conversation', async () => {
 const app=setup();const {id}=await app.send({type:'WEB_START',cues});await app.send({type:'WEB_SENT',id},app.gemini);
 for(const url of ['https://evil.test/u/2/app/stolen','https://gemini.google.com/u/3/app/wrong','https://gemini.google.com/u/2/application/wrong','https://gemini.google.com/u/2/app/chat/extra']) await app.tabUrlChanged(99,url);
 await app.tabUrlChanged(100,'https://gemini.google.com/u/2/app/foreign-tab');
 assert.equal(app.saved.geminiBrowserSession.chatUrl,'https://gemini.google.com/u/2/app');
});


async function missingChatJob() {
 const saved={geminiAccountIndex:2,geminiAccountEmail:'pro@example.com',geminiBrowserSession:{tabId:98,accountIndex:2,email:'pro@example.com',chatUrl:'https://gemini.google.com/u/2/app/deleted-chat'}};
 const app=setup(saved); app.context.chrome.tabs.get=async()=>{throw new Error('closed');};
 const {id}=await app.send({type:'WEB_START',cues});
 app.context.chrome.tabs.get=async id=>({id,url:'https://gemini.google.com/u/2/app'});
 return {app,id,message:{type:'WEB_CHAT_MISSING',id,conversationUrl:saved.geminiBrowserSession.chatUrl,reason:'redirected-empty'}};
}

test('missing chat recovery survives restart, resends every original cue with fresh markers, and pins only the replacement chat', async () => {
 const {app,id,message}=await missingChatJob();
 assert.equal((await app.send(message,app.gemini)).claimed,true);
 let resumed=setup(app.saved);let task=await resumed.send({type:'WEB_TASK'},resumed.gemini);
 assert.equal(task.state,'ready');assert.equal(core.parseSubtitles(task.srt).length,2);assert.equal(task.responseId,id+'_chat1');
 assert.match(task.prompt,new RegExp('BEGIN_'+id+'_chat1'));assert.equal(task.chatProbe,false);
 await resumed.send({type:'WEB_SENT',id},resumed.gemini);
 assert.equal((await resumed.send({type:'WEB_RESULT',id,responseId:id,raw:jsonReply(id)},resumed.gemini)).ignored,true);
 assert.equal(resumed.saved.browserSubtitleJob.state,'waiting');
 await resumed.tabUrlChanged(99,'https://gemini.google.com/u/2/app/deleted-chat');
 assert.equal(resumed.saved.geminiBrowserSession.chatUrl,'https://gemini.google.com/u/2/app');
 await resumed.tabUrlChanged(99,'https://gemini.google.com/u/2/app/replacement');
 assert.equal(resumed.saved.geminiBrowserSession.chatUrl,'https://gemini.google.com/u/2/app/replacement');
 assert.equal((await resumed.send({type:'WEB_RESULT',id,responseId:task.responseId,raw:jsonReply(task.responseId)},resumed.gemini)).done,true);
 const next=await resumed.send({type:'WEB_START',cues:cues.map(c=>({...c,text:c.text+' next'}))});
 assert.equal(next.ok,true);assert.equal(resumed.created,0);assert.equal(resumed.saved.geminiBrowserSession.chatUrl,'https://gemini.google.com/u/2/app/replacement');
 assert.equal(resumed.saved.geminiAccountEmail,'pro@example.com');
});

test('stale missing-chat reports, foreign tabs and a normal manual New chat cannot replace the pinned conversation', async () => {
 const {app,message}=await missingChatJob();
 assert.equal((await app.send({...message,conversationUrl:'https://gemini.google.com/u/2/app/other'},app.gemini)).claimed,false);
 assert.equal((await app.send(message,{...app.gemini,tab:{id:100}})).idle,true);
 assert.equal(await app.send(message,app.udemy),false);
 app.saved.browserSubtitleJob.chatProbe=false;
 assert.equal((await app.send(message,app.gemini)).claimed,false);
 assert.equal(app.saved.geminiBrowserSession.chatUrl,message.conversationUrl);
});

test('explicit missing-chat page navigates to a fresh composer once and repeated recovery fails closed', async () => {
 const {app,id,message}=await missingChatJob();let navigated;
 app.context.chrome.tabs.get=async id=>({id,url:message.conversationUrl});
 app.context.chrome.tabs.update=async(tabId,options)=>{navigated={tabId,...options};};
 assert.equal((await app.send({...message,reason:'not-found'},app.gemini)).claimed,true);
 assert.equal(navigated.tabId,99);assert.equal(navigated.url,'https://gemini.google.com/u/2/app#udemy-srt='+id);
 app.saved.browserSubtitleJob.conversationUrl=message.conversationUrl;app.saved.geminiBrowserSession.chatUrl=message.conversationUrl;
 assert.equal((await app.send({...message,reason:'not-found'},app.gemini)).ok,false);
 assert.equal(app.saved.browserSubtitleJob.chatRecoveries,1);
});
