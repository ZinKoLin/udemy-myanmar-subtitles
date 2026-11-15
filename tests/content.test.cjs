const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../core.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function page(options = {}) {
  let now = 100000, previewLabel = 'Preview one.mp4', selectedPreview = 'Preview one', activeVideo, savedVideo, previewOpen=true;
  const previewPlayerNode = {closest:()=>previewDialog,getAttribute: name => name === 'aria-label' ? previewLabel : null};
  const previewDialog = {querySelector: selector => selector.includes('media-player-container') ? previewPlayerNode : {textContent:selectedPreview}};
  const nodes = [], documentEvents = {}, timers = [], downloads = [], fetched = []; let captionWrites = 0;
  class Element {
    constructor(tag) { this.tag = tag; this.textContent = ''; this.style = {}; this.dataset = {}; this.handlers = {}; this.attributes = {}; this.children = []; this.offsetHeight = 20; nodes.push(this); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    attachShadow() { return this.shadowRoot = new Element('shadow'); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    focus() {}
    click() {}
    remove() {}
    closest(selector) { return options.preview && selector === '[role="dialog"]' ? previewDialog : null; }
    querySelectorAll() { return []; }
    get textContent() { return this._text || ''; }
    set textContent(value) { this._text = value; if (this.className === 'burmese') captionWrites++; }
    getBoundingClientRect() { return { top: 0, left: 0, width: 640, height: 360, bottom: 360 }; }
  }
  const video = new Element('video');
  Object.assign(video, { currentSrc: 'lecture.mp4', paused: false, currentTime: 0, textTracks: [{ language: 'en', kind: 'captions', mode: 'hidden', cues: [
    { startTime: 0.125, endTime: 2, text: 'First' }, { startTime: 3, endTime: 5.75, text: 'Second' }
  ] }], pause() { this.paused = true; } });
  activeVideo = video;
  let interval, state = 'waiting';
  const document = {
    documentElement: new Element('html'), createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }),
    addEventListener: (name, handler) => { documentEvents[name] = handler; },
    querySelector: selector => options.preview && previewOpen && selector === '[role="dialog"] [data-purpose="media-player-container"]' ? previewPlayerNode : null, querySelectorAll: selector => selector === 'video' && activeVideo ? [activeVideo] : []
  };
  if (options.preview) { video.textTracks = []; video.currentSrc = 'blob:preview-one'; }
  if (options.coursera) {
    video.textTracks = [];
    video.querySelectorAll = () => [{ srclang: 'en', label: 'English', src: '/api/subtitleAssetProxy.v1/english?fileExtension=vtt' }];
  }
  class TestURL extends URL { static createObjectURL(blob) { downloads.push(blob); return 'blob:download'; } static revokeObjectURL() {} }
  const requests = [], resources = options.resources || [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../content.js'), 'utf8'), {
    SubtitleCore: core, BrowserSubtitleCore: require('../browser-core.js'), CourseraSubtitleSource: require('../coursera-core.js'), URL: TestURL, Blob, AbortSignal,
    fetch: async (url, init) => { fetched.push({url, init}); return { ok: !options.denied, text: async () => 'WEBVTT\n\n00:00:00.125 --> 00:00:02.000\nFirst\n\n00:00:03.000 --> 00:00:05.750\nSecond' }; },
    PreviewSubtitleSource: require('../preview-core.js'), performance: { getEntriesByType: () => resources, now: () => 100 }, PerformanceObserver: class { observe() {} }, document, window: { addEventListener() {} }, location: { hostname: options.coursera ? 'www.coursera.org' : 'www.udemy.com', href: 'https://www.coursera.org/learn/test/lecture/one/introduction', pathname: options.coursera ? '/learn/test/lecture/one/introduction' : options.preview ? '/course/test/' : '/course/test/learn/lecture/1' }, Date: class extends Date {static now(){return now;}}, innerHeight: 800, queueMicrotask,
    setInterval(fn) { interval = fn; }, setTimeout(fn, delay) { fn.delay = delay; timers.push(fn); return fn; }, clearTimeout(fn) { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); },
    chrome: { runtime: { onMessage: { addListener() {} }, async sendMessage(message) {
      requests.push(message);
      if (message.type === 'FETCH_CAPTION') return { ok: true, text: 'WEBVTT\n\n00:00:00.125 --> 00:00:02.000\nFirst\n\n00:00:03.000 --> 00:00:05.750\nSecond' };
      if (message.type === 'GET_PREFERENCES') return { ok: true, preferences: { autoTranslate: !!options.autoTranslate } };
      if (message.type === 'GET_PROVIDER') return { ok: true, provider: 'browser', browserModel: 'flash-lite' };
      if (message.type === 'WEB_START') return { ok: true, id: 'job' };
      if (message.type === 'WEB_STATUS') return { ok: true, state, texts: ['ပထမ', 'ဒုတိယ'], error: 'Failed' };
      return { ok: true };
    } } }
  });
  await flush(); interval(); await flush();
  return { get video(){return activeVideo;}, hideVideo(){savedVideo=activeVideo;activeVideo=null;}, restoreVideo(){activeVideo=savedVideo;}, closePreview(){previewOpen=false;activeVideo=null;}, async tick(ms=1100){now+=ms;interval();await flush();}, selectPreview(label){previewLabel=label;selectedPreview=label;}, replaceVideo(){const replacement=new Element('video');Object.assign(replacement,{currentSrc:activeVideo.currentSrc,paused:activeVideo.paused,currentTime:activeVideo.currentTime,textTracks:[],pause(){this.paused=true;}});activeVideo=replacement;}, nodes, requests, downloads, fetched, documentEvents, timers, interval, get captionWrites() { return captionWrites; }, setState(value) { state = value; },
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
test('ready notice disappears after six seconds without clearing subtitles; pending warnings remain visible', async () => {
  const app = await page(); app.find('Translate').handlers.click(); await flush();
  app.setState('done'); await app.poll();
  const dismiss = app.timers.find(timer => timer.delay === 6000); assert.ok(dismiss);
  dismiss(); assert.equal(app.notice.hidden, true); assert.equal(app.nodes.find(n => n.id === 'launcher').textContent, '⚙ Subtitles');
  app.video.currentTime = 1; app.interval(); assert.equal(app.nodes.find(n => n.className === 'burmese').textContent, 'ပထမ');
  app.setState('waiting'); app.find('Translate').handlers.click(); await flush();
  dismiss(); assert.equal(app.notice.hidden, false); assert.equal(app.notice.dataset.state, 'translating');
});

test('preview downloads its complete VTT, sends one whole SRT job and renders original millisecond boundaries after seeking', async () => {
  const app = await page({ preview: true, resources: [{ name: 'https://vtt-cf.udemycdn.com/123/en_US/original.vtt', startTime: 10 }] });
  app.find('Translate').handlers.click(); await flush();
  const download = app.requests.find(r => r.type === 'FETCH_CAPTION');
  assert.equal(download.url, 'https://vtt-cf.udemycdn.com/123/en_US/original.vtt');
  const jobs = app.requests.filter(r => r.type === 'WEB_START');
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].cues.map(c => [c.start, c.end, c.text]), [[0.125, 2, 'First'], [3, 5.75, 'Second']]);
  assert.equal(app.video.paused, true);
  app.setState('done'); await app.poll();
  const overlay = app.nodes.find(n => n.shadowRoot?.children.some(c => c.className === 'box'));
  app.video.currentTime = 3; app.interval(); assert.equal(app.nodes.find(n => n.className === 'burmese').textContent, 'ဒုတိယ');
  app.video.currentTime = 0.124; app.interval(); assert.equal(overlay.style.display, 'none');
  app.video.currentTime = 0.125; app.interval(); assert.equal(app.nodes.find(n => n.className === 'burmese').textContent, 'ပထမ');
  app.video.currentTime = 2; app.interval(); assert.equal(overlay.style.display, 'none');
});

test('Coursera fetches a complete English subtitle file once, translates in one job and exports both SRTs at original times', async () => {
  const app = await page({ coursera: true });
  app.find('မြန်မာ SRT').handlers.click(); assert.equal(app.downloads.length, 0);
  app.find('Translate').handlers.click(); await flush();
  assert.equal(app.fetched.length, 1); assert.equal(app.fetched[0].init.credentials, 'same-origin');
  const jobs = app.requests.filter(r => r.type === 'WEB_START'); assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].cues.map(c => [c.start, c.end]), [[0.125, 2], [3, 5.75]]);
  assert.equal(app.video.paused, true);
  app.setState('done'); await app.poll();
  await app.find('English SRT').handlers.click(); app.find('မြန်မာ SRT').handlers.click();
  assert.equal(app.fetched.length, 1); assert.equal(app.downloads.length, 2);
  const english = core.parseSubtitles(await app.downloads[0].text()), burmese = core.parseSubtitles(await app.downloads[1].text());
  assert.deepEqual(english.map(c => c.text), ['First', 'Second']); assert.deepEqual(burmese.map(c => c.text), ['ပထမ', 'ဒုတိယ']);
  assert.deepEqual(english.map(c => [c.start,c.end]), burmese.map(c => [c.start,c.end]));
  app.video.currentTime = 3; app.interval(); assert.equal(app.nodes.find(n => n.className === 'burmese').textContent, 'ဒုတိယ');
});

test('Coursera login or access failures never send a partial subtitle job', async () => {
  const app = await page({ coursera: true, denied: true });
  app.find('Translate').handlers.click(); await flush();
  assert.equal(app.requests.some(r => r.type === 'WEB_START'), false); assert.equal(app.notice.dataset.state, 'error');
});


test('automatic preview translation survives blob churn and video replacement without cancelling or resending', async () => {
 const app=await page({preview:true,autoTranslate:true,resources:[{name:'https://vtt-cf.udemycdn.com/123/en_US/original.vtt',startTime:10}]});
 await app.tick(2000); assert.equal(app.requests.filter(r=>r.type==='WEB_START').length,1);
 for(let i=0;i<5;i++){app.video.currentSrc='blob:transport-'+i;await app.tick();}
 app.hideVideo();await app.tick();app.restoreVideo();await app.tick();
 app.replaceVideo();await app.tick();
 assert.equal(app.requests.filter(r=>r.type==='WEB_CANCEL').length,0);assert.equal(app.requests.filter(r=>r.type==='WEB_START').length,1);
 app.setState('done');await app.poll();app.video.currentTime=3;await app.tick();
 assert.equal(app.nodes.find(n=>n.className==='burmese').textContent,'ဒုတိယ');
 app.video.currentSrc='blob:after-completion';await app.tick();
 assert.equal(app.requests.filter(r=>r.type==='WEB_START').length,1);assert.equal(app.notice.dataset.state,'ready');
});

test('a genuinely different preview still invalidates and cancels its previous subtitles', async () => {
 const app=await page({preview:true,resources:[{name:'https://vtt-cf.udemycdn.com/123/en_US/original.vtt',startTime:10}]});
 app.find('Translate').handlers.click();await flush();app.selectPreview('Different preview.mp4');app.video.currentSrc='blob:other';await app.tick();
 assert.equal(app.requests.filter(r=>r.type==='WEB_CANCEL').length,1);
 assert.notEqual(app.notice.dataset.state,'ready');
});


test('closing the preview still cancels a pending job after temporary video gaps are tolerated', async () => {
 const app=await page({preview:true,resources:[{name:'https://vtt-cf.udemycdn.com/123/en_US/original.vtt',startTime:10}]});
 app.find('Translate').handlers.click();await flush();app.closePreview();await app.tick();
 assert.equal(app.requests.filter(r=>r.type==='WEB_CANCEL').length,1);
});
