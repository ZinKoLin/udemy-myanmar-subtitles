const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function driver(options = {}) {
  let tick, wake, now = 0, uploads = 0, clicks = 0, state = 'ready', response = '', result, failure, timerActive = false, repaired = false;
  let generatingActive = !!options.generating, busyReports = 0;
  let submittedPrompt = '', retryMenu = false, retries = 0, chatRecoveries = 0;
  const fileList = [];
  const task = { id: options.truncated ? '1234567890abcdef1234567890abcdef' : 'job', expectedEmail: 'pro@example.com', accountIndex: 2, browserModel: options.model || 'argon-medium', srt: '1\n00:00:00,000 --> 00:00:02,000\nHello\n', prompt: 'Translate the whole file. BEGIN_job END_job' };
  task.prompt = `Translate the whole file.\nBEGIN_${task.id}\nEND_${task.id}`;
  if (options.workerRecovery) task.recovery=true;
  if (options.resumeRecovery) { state='waiting'; task.recovery=true; task.delivery={phase:'claimed'}; task.repair=false; task.responseId='job_chat1'; task.deliveryPrompt='Translate all fragments. BEGIN_job_chat1 END_job_chat1'; task.recoverySrt=task.srt; }
  if (options.missingChat) { task.conversationUrl = 'https://gemini.google.com/u/2/app/deleted-chat'; task.chatProbe = !options.noProbe; }
  const element = label => ({ style: {}, textContent: '', isConnected: false, getAttribute: name => name === 'aria-label' ? label : null, getClientRects: () => [{}], classList: { contains: () => false }, focus() {}, dispatchEvent() {} });
  let box = element('Enter a prompt for Gemini');
  const composer = { textContent: '', querySelectorAll(selector) { if (!options.truncated || !this.textContent) return []; const chip = element(); chip.textContent = this.textContent; return selector.includes('.gem-attachment-text') ? [chip] : []; } };
  box.closest = () => composer;
  if (options.paragraphs) { let rendered = ''; Object.defineProperty(box,'innerText',{get:()=>rendered}); Object.defineProperty(box,'textContent',{get:()=>rendered.replace(/\n/g,''),set:value=>{rendered=value;}}); }
  if (options.staleDraft) { box.textContent = 'Old generated prompt. BEGIN_old END_old'; task.ownedDrafts = [{responseId:'old',fileBase:'udemy-old',hash:require('node:crypto').createHash('sha256').update(box.textContent).digest('hex')}]; }
  if (options.userDraft) box.textContent = options.userDraft;
  if (options.hydrating) box.textContent = 'Ask Gemini';
  const account = element(options.wrongAccount ? 'Google Account: Other (other@example.com)' : 'Google Account: Pro (pro@example.com)');
  let pickerLabel = options.selected || (options.wrongModel ? 'Open mode picker, currently Gemini Auto' : 'Open mode picker, currently Argon Medium');
  const picker = element(); picker.getAttribute = name => name === 'aria-label' ? pickerLabel : null;
  const modelChoice = element(); modelChoice.textContent = options.model === 'hydrogen-medium' ? 'Hydrogen' : 'Quick answers 3.5 Flash-Lite';
  modelChoice.getAttribute = name => name === 'aria-disabled' ? String(!!options.limited) : null;
  modelChoice.click = () => { pickerLabel = options.model === 'hydrogen-medium' ? 'Open mode picker, currently Hydrogen Medium' : 'Open mode picker, currently Flash-Lite'; if (options.remount) { box = element('Enter a prompt for Gemini'); box.closest = () => composer; } };
  picker.click = () => {};
  const sendButton = element('Send message'); sendButton.click = () => { clicks++; if (options.stuckSend && clicks <= options.stuckSend) return; submittedPrompt = box.innerText ?? box.textContent; box.textContent = ''; composer.textContent = ''; };
  const stopButton = element('Stop response');
  const redo = element('Redo'); redo.click = () => { retryMenu = true; };
  const again = element(); again.textContent = 'Try again'; again.click = () => { retries++; retryMenu = false; response = ''; };
  const body = { textContent: '' };
  const input = { accept: '.txt,.srt', getAttribute(name) { return name === 'accept' ? this.accept : null; }, dispatchEvent() { uploads++; body.textContent = fileList.at(-1)?.name || ''; composer.textContent = options.truncated ? body.textContent.slice(0,10) + '...' + body.textContent.slice(-14,-4) : options.baseOnly ? body.textContent.replace('.srt','') : body.textContent; } };
  Object.defineProperty(input, 'files', { set(value) { fileList.push(...value); } });
  const context = vm.createContext({
    crypto: { randomUUID: () => 'test-client', subtle: { digest: async (_, data) => require('node:crypto').createHash('sha256').update(data).digest() } }, TextEncoder,
    location: { hash: '#udemy-srt=job', href: options.accountUrl || (options.missingChat ? 'https://gemini.google.com/u/2/app' : undefined) },
    Date: class extends Date { static now() { return now; } },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setInterval(fn) { tick = fn; timerActive = true; return 1; }, clearInterval() { timerActive = false; },
    setTimeout(fn, ms) { now += ms; if (options.hydrating && ms === 400) box.textContent = ''; queueMicrotask(fn); },
    Event: class {}, InputEvent: class {}, File: require('node:buffer').File,
    DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } },
    document: {
      body, createElement: () => element(), documentElement: { append(e) { e.isConnected = true; } },
      execCommand(command, ui, text) { if (command === 'insertText') box.textContent = text; if (command === 'delete') box.textContent = ''; return true; },
      querySelectorAll(selector) {
        if (selector === '.inline-upgrade-banner-text') { const banner = element(); banner.textContent = options.quota; return options.quota ? [banner] : []; }
        if (selector.includes('Google Account:')) return [account];
        if (selector.startsWith('[contenteditable')) return [box];
        if (selector === 'h1' && options.missingChat) { const h=element(); h.textContent='Where should we start?'; return [h]; }
        if (selector.includes('[role="progressbar"]') && options.loading) return [element()];
        if (selector === 'button') return [picker, sendButton, redo,...(generatingActive?[stopButton]:[])];
        if (selector === '[role="menuitem"]') return retryMenu ? [again] : [];
        if (selector === '[role="menuitemradio"]' && options.model) return [modelChoice];
        if (selector.includes('input[type=')) return options.staleInput ? [{accept:'.srt',getAttribute:()=>'.srt',dispatchEvent(){ throw new Error('Inactive uploader must not receive a file'); }},input] : [input];
        if (selector === 'user-query') return (response && options.hidePrompt) ? [] : submittedPrompt ? [{ innerText: response ? (options.latestPrompt || submittedPrompt) : submittedPrompt, compareDocumentPosition: () => options.disconnectedPrompt ? 5 : options.promptAfterResponse ? 2 : 4 }] : [];
        if (selector.startsWith('model-response')) return response ? [...(options.oldHistory ? Array.from({length: 100}, () => ({ get innerText() { throw new Error('Old chat text must not be read'); } })) : []), { innerText: response, querySelectorAll: () => options.codeText ? [{textContent:options.codeText}] : options.codeBlock ? [{ textContent: task.srt }] : [] }] : [];
        return [];
      }
    },
    chrome: { runtime: { id: 'test', onMessage: { addListener(fn) { wake = fn; } }, async sendMessage(message) {
      if (message.type === 'WEB_ACCOUNT') { options.accountReports?.push(message.email); return {ok:true,adopted:true,changed:false}; }
      if (message.type === 'WEB_TASK') return { ok: true, ...task, state };
      if (message.type === 'WEB_DELIVERY') { if(message.stage==='ack')task.delivery.phase='submitted'; return {ok:true,claimed:true}; }
      if (message.type === 'WEB_CHAT_MISSING') { chatRecoveries++; task.conversationUrl='https://gemini.google.com/u/2/app'; task.chatProbe=false; task.responseId='job_chat1'; task.prompt='Translate all fragments. BEGIN_job_chat1 END_job_chat1'; state='ready'; return {ok:true,claimed:true}; }
      if (message.type === 'WEB_BUSY') { busyReports++; return {ok:true}; }
      if (message.type === 'WEB_SENT') { state = 'waiting'; if(task.recovery)task.delivery={phase:'claimed'}; return { ok: true, claimed: !options.alreadyClaimed }; }
      if (message.type === 'WEB_REPAIR_SENT') { state = 'waiting'; return {ok:true,claimed:true}; }
      if (message.type === 'WEB_RESULT' && options.repair && !repaired) { repaired = true; state = 'repair-ready'; task.responseId = 'job_repair1'; task.repairPrompt = 'Translate all original fragments with their IDs. BEGIN_job_repair1 END_job_repair1'; return {ok:true,repair:true}; }
      if (message.type === 'WEB_RESULT') { result = message.raw; state = 'done'; return { ok: true, done: true }; }
      if (message.type === 'WEB_ERROR') { failure = message.error; state = 'error'; }
      return { ok: true };
    } } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../gemini-browser.js'), 'utf8'), context);
  await flush();
  return { get busyReports(){return busyReports;}, setGenerating(value){generatingActive=value;}, fileList, task, get chatRecoveries() { return chatRecoveries; }, get timerActive() { return timerActive; }, get retries() { return retries; }, get draft() { return box.textContent; }, get uploads() { return uploads; }, get clicks() { return clicks; }, get failure() { return failure; }, get result() { return result; }, async elapse(ms) { now += ms; }, async poll(text) { if (text !== undefined) response = text; now += 2000; tick(); await flush(); }, async nextJob() { task.id = 'job2'; delete task.responseId; task.prompt = 'Translate the whole file. BEGIN_job2 END_job2'; state = 'ready'; response = ''; result = undefined; wake({ type: 'BROWSER_JOB_AVAILABLE' }); await flush(); } };
}
test('browser uploads exactly one complete SRT and waits for a stable complete marked response', async () => {
  const app = await driver();
  assert.equal(app.uploads, 1); assert.equal(app.clicks, 1);
  assert.equal(app.fileList.length, 1); assert.equal(app.fileList[0].name, 'udemy-job.srt');
  assert.equal(await app.fileList[0].text(), app.task.srt);
  await app.poll('BEGIN_job\npartial'); assert.equal(app.result, undefined);
  await app.poll('BEGIN_job\ncomplete\nEND_job'); assert.equal(app.result, undefined);
  await app.poll(); assert.equal(app.result, undefined);
  await app.poll(); assert.equal(app.result, 'BEGIN_job\ncomplete\nEND_job');
});

test('visible Gemini identity is reported once before translation and is not repeatedly saved on polling', async () => {
  const options = {accountUrl:'https://gemini.google.com/u/2/app',accountReports:[]};
  const app = await driver(options);
  assert.deepEqual(options.accountReports,['pro@example.com']);
  await app.poll(); await app.poll();
  assert.deepEqual(options.accountReports,['pro@example.com']);
  assert.equal(app.uploads,1); assert.equal(app.clicks,1);
});
test('wrong Pro account or unavailable Argon Medium never uploads or sends a file', async () => {
  const account = await driver({ wrongAccount: true });
  assert.equal(account.uploads, 0); assert.equal(account.clicks, 0); assert.match(account.failure, /not the configured Pro account/);
  const model = await driver({ wrongModel: true });
  assert.equal(model.uploads, 0); assert.equal(model.clicks, 0); assert.match(model.failure, /controls are unavailable/);
});
test('rendered SRT code is extracted without Copy button text or language labels', async () => {
  const app = await driver({ codeBlock: true });
  await app.poll('BEGIN_job\nSRT\nCopy code\nrendered content\nEND_job');
  await app.poll(); await app.poll();
  assert.equal(app.result, `BEGIN_job\n${app.task.srt}\nEND_job`);
});

test('complete JSON with the exact job END marker survives a missing BEGIN, but wrong job endings stay rejected', async () => {
  const json = '[{"id":"C000001","text":"မင်္ဂလာပါ"}]';
  for (const codeText of [json, json + '\nEND_job']) {
    const app = await driver({ codeText });
    await app.poll('JSON\n' + json + '\nEND_other'); await app.poll(); await app.poll();
    assert.equal(app.result, undefined);
    await app.poll('JSON\n' + json + '\nEND_job'); await app.poll(); await app.poll();
    assert.equal(app.result, 'BEGIN_job\n' + json + '\nEND_job');
  }
});

test('markerless JSON requires the latest connected prompt of this job before its response', async () => {
  const json = '[{"id":"C000001","text":"မင်္ဂလာပါ"}]';
  for (const options of [ {hidePrompt:true}, { latestPrompt: 'BEGIN_other\nEND_other' }, { latestPrompt: 'BEGIN_job\nEND_job', promptAfterResponse: true }, { latestPrompt: 'BEGIN_job\nEND_job', disconnectedPrompt: true } ]) {
    const app = await driver({ codeText: json, ...options });
    await app.poll('JSON\n' + json); await app.poll(); await app.poll();
    assert.equal(app.result, undefined);
  }
  const app = await driver({ codeText: json, latestPrompt: 'BEGIN_job\nEND_job' });
  await app.poll('JSON\n' + json + '\nEND_other'); await app.poll(); await app.poll(); assert.equal(app.result, undefined);
  await app.poll('JSON\n' + json); await app.poll(); await app.poll();
  assert.equal(app.result, 'BEGIN_job\n' + json + '\nEND_job');
});

test('BEGIN without END accepts only the latest connected job and still rejects foreign markers', async () => {
  const json = '[{"id":"C000001","text":"မြန်မာ"}]';
  for (const opts of [{}, {hidePrompt:true}, {latestPrompt:'BEGIN_other END_other'}, {promptAfterResponse:true}, {disconnectedPrompt:true}]) {
    const app = await driver({codeText:json, ...opts});
    await app.poll('BEGIN_job\n'+json+'\nEND_other'); await app.poll(); await app.poll();
    assert.equal(app.result, undefined);
    await app.poll('BEGIN_job\n'+json); await app.poll(); await app.poll();
    assert.equal(app.result, Object.keys(opts).length ? undefined : 'BEGIN_job\n'+json+'\nEND_job');
    assert.equal(app.uploads, 1); assert.equal(app.clicks, 1);
  }
});

test('quota banner stops before upload and reports the displayed reset time', async () => {
  const app = await driver({quota:'Limit reached · Resets at 21:19'});
  assert.equal(app.uploads, 0); assert.equal(app.clicks, 0);
  assert.match(app.failure, /Gemini limit/); assert.match(app.failure, /21:19/);
  assert.equal(app.timerActive, false);
});

test('quota reached while waiting stops without resending, but a complete reply is collected first', async () => {
  const options = {};
  const app = await driver(options);
  options.quota = 'Limit reached · Resets at 21:19';
  await app.poll();
  assert.match(app.failure, /Gemini limit/);
  assert.equal(app.uploads, 1); assert.equal(app.clicks, 1); assert.equal(app.timerActive, false);
  const fullOptions = {codeText:'[{"id":"C000001","text":"မြန်မာ"}]'};
  const full = await driver(fullOptions);
  fullOptions.quota = options.quota;
  await full.poll('BEGIN_job\n'+fullOptions.codeText); await full.poll(); await full.poll();
  assert.ok(full.result); assert.equal(full.failure, undefined);
  assert.equal(full.uploads, 1); assert.equal(full.clicks, 1);
});
test('a finished chat adapter wakes for the next full SRT without reloading or creating another chat', async () => {
  const app = await driver();
  await app.poll('BEGIN_job\ncomplete\nEND_job'); await app.poll(); await app.poll();
  assert.ok(app.result);
  await app.nextJob();
  assert.equal(app.uploads, 2); assert.equal(app.clicks, 2); assert.equal(app.failure, undefined);
  await app.poll('BEGIN_job2\nnext complete\nEND_job2'); await app.poll(); await app.poll();
  assert.equal(app.result, 'BEGIN_job2\nnext complete\nEND_job2');
});
test('Gemini editor hydration settles before a full SRT is sent', async () => {
  const app = await driver({ hydrating: true });
  assert.equal(app.uploads, 1); assert.equal(app.clicks, 1); assert.equal(app.failure, undefined);
});
test('a second adapter cannot upload or send a job already claimed by another adapter', async () => {
  const app = await driver({ alreadyClaimed: true });
  assert.equal(app.uploads, 0); assert.equal(app.clicks, 0); assert.equal(app.failure, undefined);
});

 test('explicit Flash-Lite and Hydrogen choices select the requested model before uploading', async () => {
  for (const model of ['flash-lite', 'hydrogen-medium']) {
    const app = await driver({ model });
    assert.equal(app.uploads, 1); assert.equal(app.clicks, 1); assert.equal(app.failure, undefined);
  }
});
test('manual model selection preserves the Gemini choice and a limited model never uploads', async () => {
  const manual = await driver({ model: 'current', wrongModel: true });
  assert.equal(manual.uploads, 1); assert.equal(manual.clicks, 1);
  const limited = await driver({ model: 'flash-lite', limited: true });
  assert.equal(limited.uploads, 0); assert.equal(limited.clicks, 0); assert.match(limited.failure, /limit/);
});
test('completed adapters release their timer, skip old chat text, and wake on the next lecture', async () => {
  const app = await driver({oldHistory: true});
  assert.equal(app.timerActive, true);
  await app.poll('BEGIN_job\ncomplete\nEND_job'); await app.poll(); await app.poll();
  assert.equal(app.result, 'BEGIN_job\ncomplete\nEND_job'); assert.equal(app.failure, undefined);
  assert.equal(app.timerActive, false);
  await app.nextJob(); assert.equal(app.timerActive, true); assert.equal(app.uploads, 2);
});

test('adapter sends one correction without another file and ignores the previous answer markers', async () => {
 const app = await driver({repair:true});
 await app.poll('BEGIN_job\ninvalid complete\nEND_job'); await app.poll(); await app.poll();
 assert.equal(app.result,undefined); assert.equal(app.clicks,1);
 await app.poll(); assert.equal(app.clicks,2); assert.equal(app.uploads,1);
 await app.poll('BEGIN_job\ninvalid complete\nEND_job'); await app.poll(); await app.poll();
 assert.equal(app.result,undefined);
 await app.poll('BEGIN_job_repair1\ncorrected complete\nEND_job_repair1'); await app.poll(); await app.poll();
 assert.equal(app.result,'BEGIN_job_repair1\ncorrected complete\nEND_job_repair1'); assert.equal(app.timerActive,false);
});
test('rendered JSON code is extracted without its language or copy labels', async () => {
 const json = '[{"id":"C000001","text":"မြန်မာ"}]';
 const app = await driver({codeText:json});
 await app.poll('BEGIN_job\nJSON Copy code\n'+json+'\nEND_job'); await app.poll(); await app.poll();
 assert.equal(app.result,'BEGIN_job\n'+json+'\nEND_job');
});
test('JSON markers inside or outside a code block never introduce Copy labels or duplicated markers', async () => {
 const json = '[{"id":"C000001","text":"မြန်မာ"}]';
 for (const codeText of ['BEGIN_job\n'+json+'\nEND_job','BEGIN_job\n'+json,json+'\nEND_job']) {
   const app = await driver({codeText});
   await app.poll('BEGIN_job\nJSON Copy code\n'+json+'\nEND_job'); await app.poll(); await app.poll();
   assert.equal(app.result,'BEGIN_job\n'+json+'\nEND_job');
 }
});


test('remounted Hydrogen editor and basename-only attachment still submit the complete file', async () => {
 const app = await driver({model:'hydrogen-medium',remount:true,baseOnly:true});
 assert.equal(app.failure,undefined); assert.equal(app.uploads,1); assert.equal(app.clicks,1); assert.equal(app.draft,'');
});
test('an unchanged unsent prompt retries Send once without uploading again', async () => {
 const app = await driver({stuckSend:1});
 assert.equal(app.failure,undefined); assert.equal(app.clicks,2); assert.equal(app.uploads,1); assert.equal(app.draft,'');
});
test('a genuine user draft is preserved without uploading or sending', async () => {
 const app = await driver({userDraft:'My personal notes'});
 assert.equal(app.draft,'My personal notes'); assert.equal(app.uploads,0); assert.equal(app.clicks,0); assert.ok(app.failure);
});
test('owned transient Gemini errors use Redo then Try again without another SRT upload', async () => {
 const app = await driver();
 await app.poll('Sorry, something went wrong. Please try your request again.'); await app.poll(); await app.poll();
 assert.equal(app.retries,1); assert.equal(app.uploads,1); assert.equal(app.clicks,1); assert.equal(app.failure,undefined);
 await app.poll('BEGIN_job\ncomplete\nEND_job'); await app.poll(); await app.poll(); assert.ok(app.result);
});
test('an error beneath an unrelated prompt is never retried', async () => {
 const app = await driver({latestPrompt:'BEGIN_other END_other'});
 await app.poll('Sorry, something went wrong. Please try your request again.'); await app.poll(); await app.poll();
 assert.equal(app.retries,0); assert.equal(app.result,undefined);
});


test('Gemini mobile truncated attachment name is matched to the unique current job', async () => {
 const app = await driver({model:'hydrogen-medium',truncated:true});
 assert.equal(app.failure,undefined); assert.equal(app.uploads,1); assert.equal(app.clicks,1);
});


test('paragraph-rendered editor text is compared without concatenating job markers', async () => {
 const app = await driver({paragraphs:true});
 assert.equal(app.failure,undefined); assert.equal(app.clicks,1); assert.equal(app.uploads,1);
});
test('a verified stale extension draft is cleared automatically before a new full file', async () => {
 const app = await driver({staleDraft:true});
 assert.equal(app.failure,undefined); assert.equal(app.clicks,1); assert.equal(app.uploads,1); assert.equal(app.draft,'');
});


test('the current uploader is used when an inactive file input survives a completed answer', async () => {
 const app = await driver({staleInput:true});
 assert.equal(app.failure,undefined); assert.equal(app.uploads,1); assert.equal(app.clicks,1);
});


test('transient errors stop after two retries and never upload another file', async () => {
 const app = await driver(); const error = 'I encountered an error doing what you asked. Could you try again?';
 for (let i=0;i<3;i++) { await app.elapse(31000); await app.poll(error); await app.poll(); await app.poll(); }
 assert.equal(app.retries,2); assert.match(app.failure,/နှစ်ကြိမ်/); assert.equal(app.uploads,1); assert.equal(app.clicks,1); assert.equal(app.timerActive,false);
});


test('a settled missing-chat redirect automatically recovers before uploading, then completes and wakes for the next lesson', async () => {
 const app=await driver({missingChat:true,model:'hydrogen-medium'});
 assert.equal(app.uploads,0); await app.poll(); assert.equal(app.chatRecoveries,0);
 await app.poll(); assert.equal(app.chatRecoveries,1); assert.equal(app.uploads,0);
 await app.poll(); assert.equal(app.uploads,1); assert.equal(app.clicks,1); assert.equal(app.failure,undefined);
 await app.poll('BEGIN_job_chat1\ncomplete\nEND_job_chat1'); await app.poll(); await app.poll(); assert.ok(app.result);
 await app.nextJob(); assert.equal(app.uploads,2); assert.equal(app.chatRecoveries,1);
});

test('loading, unrelated New chat and genuine drafts never trigger missing-chat recovery', async () => {
 for(const options of [{loading:true},{noProbe:true},{userDraft:'My own draft'}]) {
  const app=await driver({missingChat:true,...options});await app.poll();await app.poll();
  assert.equal(app.chatRecoveries,0);assert.equal(app.uploads,0);if(options.userDraft)assert.equal(app.draft,'My own draft');
 }
 const wrong=await driver({missingChat:true,wrongAccount:true});assert.equal(wrong.chatRecoveries,0);assert.equal(wrong.uploads,0);
});


test('resuming a recovered chat uploads the entire SRT despite its fresh response marker', async () => {
 const app=await driver({resumeRecovery:true});
 assert.equal(app.uploads,1);assert.equal(app.clicks,1);assert.equal(app.failure,undefined);
 assert.equal(await app.fileList[0].text(),app.task.srt);
 await app.poll('BEGIN_job_chat1\ncomplete\nEND_job_chat1');await app.poll();await app.poll();assert.ok(app.result);
});


test('a busy previous Gemini answer is awaited without errors or another file, then sends the next job once', async () => {
 const app=await driver({generating:true,model:'hydrogen-medium',workerRecovery:true});
 for(let i=0;i<20;i++)await app.poll();
 assert.equal(app.failure,undefined);assert.equal(app.uploads,0);assert.equal(app.clicks,0);assert.equal(app.timerActive,true);assert.equal(app.busyReports,1);
 app.setGenerating(false);await app.poll();assert.equal(app.uploads,1);assert.equal(app.clicks,1);
 await app.poll('BEGIN_job\ncomplete\nEND_job');await app.poll();await app.poll();
 assert.ok(app.result);assert.equal(app.uploads,1);assert.equal(app.clicks,1);
});
