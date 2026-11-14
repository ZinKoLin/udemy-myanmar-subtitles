const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../core.js');
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.textContent = ''; this._value = ''; }
  get options() { return this.children; }
  get value() { return this._value || (this.tag === 'select' ? this.children[0]?.value || '' : ''); }
  set value(value) { this._value = value; }
  get lastElementChild() { return this.children.at(-1); }
  append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
  insertBefore(child, before) { child.parent = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, child); }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || child.tag === selector || selector === '[value="custom"]' && child.value === 'custom'); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(event, handler) { this.handlers[event] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('popup HTML patterns compile under Chrome Unicode-sets validation', () => {
  const html = fs.readFileSync(require.resolve('../popup.html'), 'utf8');
  for (const [, pattern] of html.matchAll(/pattern="([^"]+)"/g)) {
    const expression = new RegExp(`^(?:${pattern})$`, 'v');
    assert.equal(expression.test('gemini-3.5-flash-lite'), true);
    assert.equal(expression.test('bad/model'), false);
  }
});
async function popup(saved, listModels = async () => ({ ok: true, models: [] })) {
  const ids = ['status', 'keys', 'model', 'custom-model', 'add-key', 'model-fallback', 'fallback-1', 'fallback-2', 'provider-status', 'rotate', 'custom-label', 'settings', 'refresh-models', 'open', 'clear'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element(['model', 'fallback-1', 'fallback-2'].includes(id) ? 'select' : 'div')]));
  for (const value of ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'custom']) { const option = new Element('option'); option.value = value; nodes.model.append(option); }
  for (const id of ['fallback-1', 'fallback-2']) nodes[id].append(new Element('option'));
  const messages = [];
  const context = vm.createContext({
    SubtitleCore: core,
    document: { querySelector: selector => nodes[selector.slice(1)], createElement: tag => new Element(tag) },
    window: { close() {} },
    chrome: {
      storage: { local: { async setAccessLevel() {}, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, saved[key]])); }, async set(data) { Object.assign(saved, data); }, async remove(key) { delete saved[key]; } } },
      runtime: { async sendMessage(message) { return message.type === 'LIST_MODELS' ? listModels() : {}; } },
      tabs: { async query() { return [{ id: 1 }]; }, async sendMessage(id, message) { messages.push(message); } }
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../popup.js'), 'utf8'), context);
  await flush();
  return { nodes, messages, async change(id, value) { nodes[id].value = value; nodes[id].handlers.change({}); await flush(); } };
}
test('choosing a model saves immediately, survives reopening, and tells the lecture to regenerate', async () => {
  const saved = { apiKeys: ['secret'], model: 'gemini-3.5-flash-lite' };
  const app = await popup(saved);
  await app.change('model', 'gemini-3.8-flash');
  assert.equal(saved.model, 'gemini-3.8-flash');
  assert.equal(app.messages.at(-1).type, 'MODEL_CHANGED');
  const reopened = await popup(saved);
  assert.equal(reopened.nodes.model.value, 'gemini-3.8-flash');
  assert.deepEqual(saved.apiKeys, ['secret']);
});
test('a delayed model-list refresh cannot restore the earlier Flash selection', async () => {
  let finish;
  const saved = { model: 'gemini-3.5-flash-lite' };
  const app = await popup(saved, () => new Promise(resolve => { finish = resolve; }));
  const refresh = app.nodes['refresh-models'].handlers.click({ currentTarget: app.nodes['refresh-models'] });
  await app.change('model', 'gemini-3.8-flash');
  finish({ ok: true, models: [{ id: 'gemini-new-pro', label: 'New Pro' }] }); await refresh;
  assert.equal(app.nodes.model.value, 'gemini-3.8-flash'); assert.equal(saved.model, 'gemini-3.8-flash');
});
test('fallback order and rapid model changes persist without overwriting API keys', async () => {
  const saved = { apiKey: 'legacy-secret', model: 'gemini-3.5-flash-lite' };
  const app = await popup(saved);
  await app.change('fallback-1', 'gemini-3.8-flash');
  assert.equal(saved.fallbackModels[0], 'gemini-3.8-flash');
  app.nodes.model.value = 'gemini-3.8-flash'; app.nodes.model.handlers.change({});
  app.nodes.model.value = 'gemini-3.5-flash-lite'; app.nodes.model.handlers.change({});
  await flush();
  assert.equal(saved.model, 'gemini-3.5-flash-lite'); assert.equal(saved.apiKey, 'legacy-secret');
});
test('invalid custom model IDs cannot overwrite a working model or saved keys', async () => {
  const saved = { apiKeys: ['saved-secret'], model: 'gemini-3.5-flash-lite' };
  const app = await popup(saved);
  await app.change('model', 'custom');
  await app.change('custom-model', 'bad/model');
  assert.equal(saved.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(saved.apiKeys, ['saved-secret']);
  assert.match(app.nodes.status.textContent, /valid model IDs/);
});
