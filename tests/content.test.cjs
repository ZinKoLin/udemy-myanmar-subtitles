const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../core.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function page() {
  const nodes = [], documentEvents = {}, timers = []; let captionWrites = 0;
  class Element {
    constructor(tag) { this.tag = tag; this.textContent = ''; this.style = {}; this.dataset = {}; this.handlers = {}; this.attributes = {}; this.children = []; this.offsetHeight = 20; nodes.push(this); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    attachShadow() { return this.shadowRoot = new Element('shadow'); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    focus() {}
    get textContent() { return this._text || ''; }
    set textContent(value) { this._text = value; if (this.className === 'burmese') captionWrites++; }
    getBoundingClientRect() { return { top: 0, left: 0, width: 640, height: 360, bottom: 360 }; }
  }
  const video = new Element('video');
  Object.assign(video, { currentSrc: 'lecture.mp4', paused: false, currentTime: 0, textTracks: [{ language: 'en', kind: 'captions', mode: 'hidden', cues: [
    { startTime: 0.125, endTime: 2, text: 'First' }, { startTime: 3, endTime: 5.75, text: 'Second' }
  ] }], pause() { this.paused = true; } });
  let interval, state = 'waiting';
  const document = {
    documentElement: new Element('html'), createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }),
    addEventListener: (name, handler) => { documentEvents[name] = handler; },
    querySelector: () => null, querySelectorAll: selector => selector === 'video' ? [video] : []
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../content.js'), 'utf8'), {
    SubtitleCore: core, document, window: { addEventListener() {} }, location: { pathname: '/course/test/learn/lecture/1' }, Date, innerHeight: 800, queueMicrotask,
    setInterval(fn) { interval = fn; }, setTimeout(fn) { timers.push(fn); },
    chrome: { runtime: { onMessage: { addListener() {} }, async sendMessage(message) {
      if (message.type === 'GET_PREFERENCES') return { ok: true, preferences: { autoTranslate: false } };
      if (message.type === 'GET_PROVIDER') return { ok: true, provider: 'browser', browserModel: 'flash-lite' };
      if (message.type === 'WEB_START') return { ok: true, id: 'job' };
      if (message.type === 'WEB_STATUS') return { ok: true, state, texts: ['ပထမ', 'ဒုတိယ'], error: 'Failed' };
      return { ok: true };
    } } }
  });
  await flush(); interval(); await flush();
  return { video, nodes, documentEvents, timers, interval, get captionWrites() { return captionWrites; }, setState(value) { state = value; },
    find: text => nodes.find(n => n.tag === 'button' && n.textContent === text), notice: nodes.find(n => n.id === 'translation-notice'),
    async poll() { timers.shift()?.(); await flush(); }
  };
}

test('collapsed loading notice blocks Play until complete, then original timing controls captions and silent gaps', async () => {
  const app = await page(); app.find('Translate').handlers.click(); await flush();
  assert.equal(app.notice.hidden, false); assert.equal(app.notice.dataset.state, 'translating'); assert.equal(app.video.paused, true);
  assert.equal(app.nodes.find(n => n.id === 'subtitle-settings').hidden, true);
  app.video.paused = false; app.documentEvents.play({ target: app.video }); assert.equal(app.video.paused, true);
  app.setState('done'); await app.poll(); assert.equal(app.notice.dataset.state, 'ready');
  app.video.paused = false; app.documentEvents.play({ target: app.video }); assert.equal(app.video.paused, false);
  app.video.currentTime = 0.125; app.interval(); assert.equal(app.nodes.find(n => n.className === 'burmese').textContent, 'ပထမ');
  app.video.currentTime = 2; app.interval(); assert.equal(app.nodes.find(n => n.shadowRoot?.children.some(c => c.className === 'box')).style.display, 'none');
  app.video.currentTime = 3; app.interval(); assert.equal(app.nodes.find(n => n.className === 'burmese').textContent, 'ဒုတိယ');
});

test('failed or stopped full-file translation never leaves a green ready notice', async () => {
  for (const stop of [false, true]) {
    const app = await page(); app.find('Translate').handlers.click(); await flush();
    if (stop) app.find('Stop').handlers.click(); else { app.setState('error'); await app.poll(); }
    assert.equal(app.notice.hidden, false); assert.equal(app.notice.dataset.state, 'error');
    assert.match(app.notice.textContent, /စာတန်း မရသေးပါ/);
  }
});
test('paused lectures retain captions without rewriting identical DOM text on every tick', async () => {
  const app = await page(); app.find('Translate').handlers.click(); await flush();
  app.setState('done'); await app.poll(); app.video.currentTime = 1; app.interval();
  const writes = app.captionWrites;
  for (let i = 0; i < 20; i++) app.interval();
  assert.equal(app.captionWrites, writes); assert.equal(app.nodes.find(n => n.className === 'burmese').textContent, 'ပထမ');
  app.documentEvents.scroll(); app.interval(); assert.equal(app.captionWrites, writes);
});
