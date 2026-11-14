const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function driver(options = {}) {
  let tick, wake, now = 0, uploads = 0, clicks = 0, state = 'ready', response = '', result, failure;
  const fileList = [];
  const task = { id: 'job', expectedEmail: 'pro@example.com', accountIndex: 2, browserModel: options.model || 'argon-medium', srt: '1\n00:00:00,000 --> 00:00:02,000\nHello\n', prompt: 'Translate the whole file.' };
  const element = label => ({ style: {}, textContent: '', isConnected: false, getAttribute: name => name === 'aria-label' ? label : null, getClientRects: () => [{}], classList: { contains: () => false }, focus() {}, dispatchEvent() {} });
  const box = element('Enter a prompt for Gemini');
  if (options.hydrating) box.textContent = 'Ask Gemini';
  const account = element(options.wrongAccount ? 'Google Account: Other (other@example.com)' : 'Google Account: Pro (pro@example.com)');
  let pickerLabel = options.selected || (options.wrongModel ? 'Open mode picker, currently Gemini Auto' : 'Open mode picker, currently Argon Medium');
  const picker = element(); picker.getAttribute = name => name === 'aria-label' ? pickerLabel : null;
  const modelChoice = element(); modelChoice.textContent = options.model === 'hydrogen-medium' ? 'Hydrogen' : 'Quick answers 3.5 Flash-Lite';
  modelChoice.getAttribute = name => name === 'aria-disabled' ? String(!!options.limited) : null;
  modelChoice.click = () => { pickerLabel = options.model === 'hydrogen-medium' ? 'Open mode picker, currently Hydrogen Medium' : 'Open mode picker, currently Flash-Lite'; };
  picker.click = () => {};
  const sendButton = element('Send message'); sendButton.click = () => { clicks++; box.textContent = ''; };
  const body = { textContent: '' };
  const input = { accept: '.txt,.srt', dispatchEvent() { uploads++; body.textContent = fileList.at(-1)?.name || ''; } };
  Object.defineProperty(input, 'files', { set(value) { fileList.push(...value); } });
  const context = vm.createContext({
    location: { hash: '#udemy-srt=job' },
    Date: class extends Date { static now() { return now; } },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    setTimeout(fn, ms) { now += ms; if (options.hydrating && ms === 400) box.textContent = ''; queueMicrotask(fn); },
    Event: class {}, InputEvent: class {}, File: require('node:buffer').File,
    DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } },
    document: {
      body, createElement: () => element(), documentElement: { append(e) { e.isConnected = true; } },
      execCommand(command, ui, text) { box.textContent = text; return true; },
      querySelectorAll(selector) {
        if (selector.includes('Google Account:')) return [account];
        if (selector.startsWith('[contenteditable')) return [box];
        if (selector === 'button') return [picker, sendButton];
        if (selector === '[role="menuitemradio"]' && options.model) return [modelChoice];
        if (selector.includes('input[type=')) return [input];
        if (selector.startsWith('model-response')) return response ? [{ innerText: response, querySelectorAll: () => options.codeBlock ? [{ textContent: task.srt }] : [] }] : [];
        return [];
      }
    },
    chrome: { runtime: { id: 'test', onMessage: { addListener(fn) { wake = fn; } }, async sendMessage(message) {
      if (message.type === 'WEB_TASK') return { ok: true, ...task, state };
      if (message.type === 'WEB_SENT') { state = 'waiting'; return { ok: true, claimed: !options.alreadyClaimed }; }
      if (message.type === 'WEB_RESULT') { result = message.raw; state = 'done'; }
      if (message.type === 'WEB_ERROR') { failure = message.error; state = 'error'; }
      return { ok: true };
    } } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../gemini-browser.js'), 'utf8'), context);
  await flush();
  return { fileList, task, get uploads() { return uploads; }, get clicks() { return clicks; }, get failure() { return failure; }, get result() { return result; }, async poll(text) { if (text !== undefined) response = text; now += 2000; tick(); await flush(); }, async nextJob() { task.id = 'job2'; state = 'ready'; response = ''; result = undefined; wake({ type: 'BROWSER_JOB_AVAILABLE' }); await flush(); } };
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
