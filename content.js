(() => {
  let video = null, sourceUrl = location.pathname, cues = [], translations = new Map(), generation = 0, running = false;
  let imported = false, visible = true, lastScan = 0, ownedTrack = null, lastCaptionIndex = -1, discovering = null;
  let browserJobId = null;
  let preferences = SubtitleCore.preferences(), settingsReady = false, autoBusy = false, autoStarted = false, autoAttempts = 0, nextAutoAt = Date.now() + 1800, mediaSource = '';
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:18px;top:80px;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host{all:initial}[hidden]{display:none!important}section{width:min(290px,calc(100vw - 72px));max-height:calc(100vh - 160px);overflow-y:auto;padding:16px;border:1px solid #52617a;border-radius:12px;background:#101a2bf5;color:#edf3ff;font:13px/1.8 "Myanmar Text",sans-serif;box-shadow:0 10px 35px #0005}h2{font-size:16px;margin:0 0 8px}button,label{font:inherit}button{padding:7px 10px;border:0;border-radius:6px;background:#a5f3d1;color:#102b25;cursor:pointer;margin:4px 4px 4px 0}button.secondary{background:#293b55;color:white}button:disabled{opacity:.5;cursor:default}input[type=file]{display:none}p{margin:8px 0;color:#c5d3e7}small{display:block;color:#b9c9dd}#hide{float:right;background:transparent;color:white}#launcher{display:block;margin:0 0 8px auto;padding:8px 12px;border:1px solid #52617a;border-radius:22px;background:#101a2be8;color:#edf3ff;font:13px/1.6 "Myanmar Text",sans-serif;box-shadow:0 3px 12px #0004}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #fff;outline-offset:2px}`;
  shadow.append(style);
  function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    parent?.append(node);
    return node;
  }
  const launcher = element('button', '⚙ Subtitles', shadow); launcher.id = 'launcher';
  launcher.setAttribute('aria-controls', 'subtitle-settings');
  const readyNotice = element('button', '', shadow); readyNotice.hidden = true;
  readyNotice.setAttribute('role', 'status'); readyNotice.setAttribute('aria-live', 'polite');
  readyNotice.style.cssText = 'display:block;margin:0 0 8px auto;max-width:290px;background:#a5f3d1;color:#102b25;font:13px/1.7 "Myanmar Text",sans-serif;padding:8px 12px;border:0;border-radius:8px;cursor:pointer';
  readyNotice.addEventListener('click', () => setPanelOpen(true));
  function clearReady() { launcher.textContent = '⚙ Subtitles'; readyNotice.hidden = true; }
  function announceReady(count, cached = false) {
    launcher.textContent = '✓ Subtitles ready';
    readyNotice.textContent = `✓ စာတန်းထိုး အသင့်ဖြစ်ပြီ — ${count} / ${count}${cached ? ' (သိမ်းထားပြီးသား)' : ''}`;
    readyNotice.hidden = false;
  }
  const panel = element('section', '', shadow); panel.id = 'subtitle-settings';
  panel.setAttribute('aria-label', 'Subtitle settings');
  const hide = element('button', 'Collapse', panel); hide.id = 'hide';
  element('h2', 'Subtitle settings', panel);
  function setPanelOpen(open, focus = false) {
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    launcher.setAttribute('aria-label', open ? 'Collapse subtitle settings' : 'Open subtitle settings');
    if (focus) (open ? hide : launcher).focus();
  }
  setPanelOpen(false);
  launcher.addEventListener('click', () => setPanelOpen(panel.hidden));
  shadow.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); setPanelOpen(false, true); }
  });
  element('small', 'Automatically prepare Burmese subtitles when the lecture changes.', panel);
  const status = element('p', 'Waiting for the lecture video.', panel);
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const methodLabel = element('label', 'Translation method ', panel); methodLabel.style.display = 'block';
  const method = element('select', '', methodLabel); method.setAttribute('aria-label', 'Translation method'); method.disabled = true;
  for (const [value, title] of [['browser', 'Gemini browser — full SRT'], ['api', 'Gemini API — original method'], ['n8n', 'n8n server — full SRT']]) {
    const option = element('option', title, method); option.value = value;
  }
  const methodHelp = element('small', '', panel);
  const browserModelLabel = element('label', 'Gemini browser model ', panel); browserModelLabel.style.display = 'block';
  const browserModel = element('select', '', browserModelLabel); browserModel.setAttribute('aria-label', 'Gemini browser model'); browserModel.disabled = true;
  for (const [value, title] of [['hydrogen-medium', 'Hydrogen Medium (မူလ)'], ['argon-medium', 'Argon Medium'], ['flash-lite', 'Flash-Lite'], ['current', 'Gemini မှာ ကိုယ်တိုင်ရွေးထားသည့် model']]) {
    const option = element('option', title, browserModel); option.value = value;
  }
  element('small', 'Model limit ဖြစ်လျှင် ပြောင်းရွေးပြီး Translate ပြန်နှိပ်ပါ။ ကိုယ်တိုင်ရွေးသည့်နည်းမှာ Gemini chat ထဲတွင် model ကို အရင်ရွေးပါ။', browserModelLabel);
  browserModel.addEventListener('change', async () => {
    browserModel.disabled = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'SET_BROWSER_MODEL', model: browserModel.value });
      if (!reply?.ok) throw new Error(reply?.error || 'Model ကို မသိမ်းနိုင်ပါ။');
      browserModelChanged();
      status.textContent = 'Model ပြောင်းပြီးပါပြီ။ Translate ပြန်နှိပ်ပါ။';
    } catch (error) { status.textContent = error.message; }
    finally { await refreshMethod().catch(() => {}); }
  });
  function showMethod(provider) {
    method.value = ['api', 'n8n'].includes(provider) ? provider : 'browser';
    browserModelLabel.hidden = method.value === 'api';
    methodHelp.textContent = method.value === 'api' ? 'Original API translation: 24 lines per request. Configure keys and models in the extension popup.' : method.value === 'n8n' ? 'Full SRT through n8n. Gemini runs on your server; no Gemini tab opens here. Configure n8n in the extension popup.' : 'သင့် Pro အကောင့်နှင့် ရွေးထားသည့် model ဖြင့် SRT တစ်ဖိုင်လုံး ပို့ပါသည်။';
  }
  async function refreshMethod() {
    const reply = await chrome.runtime.sendMessage({ type: 'GET_PROVIDER' });
    if (!reply?.ok) throw new Error('Could not load the translation method. Reload this lecture.');
    showMethod(reply.provider); method.disabled = false;
    browserModel.value = reply.browserModel || 'hydrogen-medium'; browserModel.disabled = false;
  }
  method.addEventListener('change', async () => {
    const provider = method.value;
    autoStarted = true; cancel(); translations.clear(); clearReady(); overlay.style.display = 'none'; method.disabled = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'SET_PROVIDER', provider });
      if (!reply?.ok) throw new Error(reply?.error || 'Could not save the translation method.');
      showMethod(reply.provider);
      status.textContent = reply.provider === 'api' ? 'Original Gemini API method selected. Click Translate. API keys and model settings are preserved.' : reply.provider === 'n8n' ? 'n8n server method selected. Click Translate after server setup.' : 'Gemini browser method selected. Click Translate.';
    } catch (error) { status.textContent = error.message; await refreshMethod().catch(() => {}); }
    finally { method.disabled = false; }
  });
  // Load after the UI has been created so event handlers can safely access its controls.
  queueMicrotask(() => refreshMethod().catch(error => { status.textContent = error.message; }));
  const scan = element('button', 'Find subtitles', panel); scan.className = 'secondary';
  const start = element('button', 'Translate', panel);
  const stop = element('button', 'Stop', panel); stop.className = 'secondary'; stop.disabled = true;
  const label = element('label', '', panel);
  const toggle = element('input', '', label); toggle.type = 'checkbox'; toggle.checked = true;
  label.append(document.createTextNode(' Show Burmese subtitles'));
  const autoLabel = element('label', '', panel);
  autoLabel.style.display = 'block';
  const autoToggle = element('input', '', autoLabel); autoToggle.type = 'checkbox'; autoToggle.checked = true;
  autoLabel.append(document.createTextNode(' Translate automatically'));
  const sizeLabel = element('label', 'Font size ', panel); sizeLabel.style.display = 'block';
  const size = element('select', '', sizeLabel); size.setAttribute('aria-label', 'Font size');
  for (const value of [16, 20, 23, 26, 30, 36, 42, 48]) { const option = element('option', `${value} px`, size); option.value = value; }
  const colorLabel = element('label', ' Text color ', panel);
  const color = element('input', '', colorLabel); color.type = 'color'; color.setAttribute('aria-label', 'Text color');
  const positionLabel = element('label', 'Subtitle position ', panel); positionLabel.style.display = 'block';
  const positionValue = element('output', '', positionLabel);
  const position = element('input', '', positionLabel);
  position.type = 'range'; position.min = '0'; position.max = '100'; position.step = '1'; position.value = '20';
  position.setAttribute('aria-label', 'Subtitle vertical position'); position.style.cssText = 'display:block;width:100%;accent-color:#a5f3d1';
  element('small', 'Left: lower / Right: higher', panel);
  element('small', 'If subtitles are unavailable, import an English .vtt or .srt file.', panel);
  const file = element('input', '', panel); file.type = 'file'; file.accept = '.vtt,.srt'; file.setAttribute('aria-label', 'English subtitle file');
  const chooseFile = element('button', 'Choose subtitle file', panel); chooseFile.className = 'secondary';
  const fileName = element('small', 'No file selected.', panel);
  chooseFile.addEventListener('click', () => file.click());
  element('small', 'Gemini browser sends one complete SRT file using your signed-in account. Keep its tab open until finished. API mode is optional in extension settings.', panel);
  document.documentElement.append(host);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;text-align:center;display:none;box-sizing:border-box;padding:0 12px;';
  const captionShadow = overlay.attachShadow({ mode: 'open' });
  const captionStyle = document.createElement('style');
  captionStyle.textContent = ':host{all:initial}.box{display:inline-block;max-width:100%;border-radius:6px;background:#070d16e8;padding:6px 14px;color:white;text-shadow:0 1px 2px black;font:clamp(15px,2vw,23px)/1.7 "Myanmar Text",sans-serif;white-space:pre-line;overflow-wrap:anywhere}.english{font-size:.78em;color:#d8e2ef}.burmese{color:#fff}';
  captionShadow.append(captionStyle);
  const box = element('div', '', captionShadow); box.className = 'box';
  const burmese = element('div', '', box); burmese.className = 'burmese';
  document.documentElement.append(overlay);
  const nativeCaptionStyle = document.createElement('style');
  document.documentElement.append(nativeCaptionStyle);
  function applyPreferences() {
    autoToggle.checked = preferences.autoTranslate;
    size.value = String(preferences.fontSize); color.value = preferences.fontColor;
    position.value = String(preferences.verticalPosition); positionValue.textContent = `${preferences.verticalPosition}%`;
    burmese.style.fontSize = `${preferences.fontSize}px`; burmese.style.lineHeight = '1.7'; burmese.style.color = preferences.fontColor;
    nativeCaptionStyle.textContent = visible ? '[data-purpose="captions-cue-text"]{opacity:0!important;text-shadow:none!important}video::cue{color:transparent!important;background:transparent!important;text-shadow:none!important}' : '';
  }
  async function savePreferences() {
    preferences = SubtitleCore.preferences({ autoTranslate: autoToggle.checked, fontSize: Number(size.value), fontColor: color.value, verticalPosition: Number(position.value) });
    applyPreferences();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SET_PREFERENCES', preferences });
      if (!response?.ok) throw new Error();
    } catch { status.textContent = 'Could not save subtitle settings.'; }
  }
  size.addEventListener('change', savePreferences);
  color.addEventListener('input', () => { burmese.style.color = color.value; });
  color.addEventListener('change', savePreferences);
  position.addEventListener('input', () => {
    preferences.verticalPosition = Number(position.value);
    positionValue.textContent = `${preferences.verticalPosition}%`;
  });
  position.addEventListener('change', savePreferences);
  autoToggle.addEventListener('change', () => {
    if (!autoToggle.checked) { autoStarted = true; cancel(); }
    else { autoStarted = false; autoAttempts = 0; nextAutoAt = Date.now(); }
    savePreferences();
  });
  chrome.runtime.sendMessage({ type: 'GET_PREFERENCES' }).then(response => {
    if (response?.ok) preferences = SubtitleCore.preferences(response.preferences);
  }).catch(() => {}).finally(() => { settingsReady = true; applyPreferences(); });
  function restoreTrack() { if (ownedTrack?.mode === 'hidden') ownedTrack.mode = 'disabled'; ownedTrack = null; }
  function cancel() {
    if (browserJobId) { chrome.runtime.sendMessage({ type: 'WEB_CANCEL', id: browserJobId }).catch(() => {}); browserJobId = null; }
    generation++; running = false; start.disabled = false; stop.disabled = true;
  }
  function reset() {
    cancel(); restoreTrack(); cues = []; translations.clear(); clearReady(); imported = false; file.value = ''; fileName.textContent = 'No file selected.'; lastCaptionIndex = -1;
    autoStarted = false; autoAttempts = 0; nextAutoAt = Date.now() + 1800;
    status.textContent = 'New lecture — waiting for subtitles.';
  }
  function readTrack() {
    if (!video) return [];
    const tracks = Array.from(video.textTracks);
    const track = tracks.find(t => /^en(?:-|$)/i.test(t.language) && ['subtitles', 'captions'].includes(t.kind)) || tracks.find(t => /english/i.test(t.label));
    if (!track) return readTranscript();
    if (track.mode === 'disabled') { track.mode = 'hidden'; ownedTrack = track; }
    return Array.from(track.cues || []).map(c => ({ start: c.startTime, end: c.endTime, text: SubtitleCore.parseSubtitles(`00:00:00.000 --> 00:00:01.000\n${c.text}`)[0]?.text || '' })).filter(c => c.text && c.end > c.start).sort((a, b) => a.start - b.start);
  }
  function transcriptNodes() {
    return Array.from(document.querySelectorAll('[data-purpose="transcript-cue"], [data-purpose="transcript-cue-active"]'));
  }
  function readTranscript() {
    return transcriptNodes().map(node => ({ text: node.querySelector('[data-purpose="cue-text"]')?.textContent.trim() || node.textContent.trim(), transcript: true })).filter(c => c.text);
  }
  function transcriptIndex() {
    const nodes = transcriptNodes();
    const index = nodes.findIndex(node => node.getAttribute('data-purpose') === 'transcript-cue-active');
    const caption = document.querySelector('[data-purpose="captions-cue-text"]');
    if (!caption || !caption.getClientRects().length || getComputedStyle(caption).visibility === 'hidden') return -1;
    const selectedLanguage = document.querySelector('[data-purpose="captions-dropdown-menu"] [aria-checked="true"]')?.textContent.trim();
    if (selectedLanguage && !/^English(?:\s|$)/i.test(selectedLanguage)) return -1;
    const hint = index >= 0 && nodes.length === cues.length && nodes.every((node, i) => node.textContent.trim() === cues[i].text) ? index : lastCaptionIndex;
    const matched = SubtitleCore.captionIndex(cues, caption.textContent, hint);
    if (matched >= 0) lastCaptionIndex = matched;
    return matched;
  }
  async function captureTranscript(token) {
    const existing = readTranscript();
    if (existing.length) return existing;
    const button = document.querySelector('[data-purpose="transcript-toggle"]');
    if (!button) return [];
    let sidebar = document.querySelector('[data-purpose="sidebar-button-close"]')?.parentElement;
    while (sidebar && !sidebar.querySelector('[role="tab"]')) sidebar = sidebar.parentElement;
    const previousTab = sidebar?.querySelector('[role="tab"][aria-selected="true"]');
    const previousLocation = location.pathname;
    button.click();
    try {
      // Wait only for the player to render its own transcript, never guess timings.
      for (let attempt = 0; attempt < 40; attempt++) {
        if (token !== generation || location.pathname !== previousLocation) return [];
        const found = readTranscript();
        if (found.length) return found;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return [];
    } finally {
      if (token === generation && location.pathname === previousLocation) {
        // Restore the user's previous sidebar or close the temporary transcript.
        if (previousTab?.isConnected && !/Transcript/i.test(previousTab.textContent)) previousTab.click();
        else document.querySelector('[data-purpose="sidebar-button-close"]')?.click();
      }
    }
  }
  async function discoverOnce() {
    if (!video) { status.textContent = 'Open a Udemy lecture video first.'; return; }
    if (running) return;
    const token = ++generation;
    let found = readTrack();
    if (!found.length) {
      status.textContent = 'Finding English subtitles…';
      for (const track of video.querySelectorAll('track')) {
        if (!/^en(?:-|$)/i.test(track.srclang) && !/english/i.test(track.label)) continue;
        try {
          const url = new URL(track.src);
          if (url.protocol !== 'https:') continue;
          const response = await fetch(url.href, { signal: AbortSignal.timeout(8000) });
          if (response.ok) found = SubtitleCore.parseSubtitles(await response.text());
          if (found.length) break;
        } catch { /* TextTrack may become available after the player's own load. */ }
      }
      if (!found.length) found = readTrack();
    }
    if (!found.length && token === generation) {
      status.textContent = 'Reading the transcript…';
      found = await captureTranscript(token);
    }
    if (token !== generation) return;
    if (found.length) {
      cues = found; imported = false; translations.clear(); clearReady(); lastCaptionIndex = -1;
      status.textContent = `Found ${cues.length} English subtitle lines. Click Translate.`;
    } else status.textContent = 'Select English captions and try again, or import a .vtt / .srt file.';
  }
  function discover() {
    if (discovering) return discovering;
    const job = discoverOnce();
    discovering = job;
    return job.finally(() => { if (discovering === job) discovering = null; });
  }
  async function timedSubtitles() {
    if (cues.length && cues.every(c => Number.isFinite(c.start) && c.end > c.start)) return cues.slice();
    const lecture = location.pathname.match(/\/lecture\/(\d+)/)?.[1];
    const slug = location.pathname.match(/\/course\/([^/]+)/)?.[1];
    if (!lecture || !slug) throw new Error('Open a Udemy lecture or import its original SRT file.');
    // Use the signed-in lecture metadata to obtain real caption timings; never infer them from transcript text.
    const courseResponse = await fetch(`/api-2.0/courses/${encodeURIComponent(slug)}/?fields[course]=id`, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
    if (!courseResponse.ok) throw new Error('Could not read Udemy caption metadata. Import the lecture’s original .srt / .vtt file.');
    const course = await courseResponse.json();
    if (!Number.isSafeInteger(course.id)) throw new Error('Could not identify this course. Import its original .srt / .vtt file.');
    const response = await fetch(`/api-2.0/users/me/subscribed-courses/${course.id}/lectures/${lecture}/?fields[lecture]=asset&fields[asset]=captions`, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Udemy did not provide timestamped captions. Import the lecture’s original .srt / .vtt file.');
    const data = await response.json();
    const caption = data.asset?.captions?.find(c => /^en(?:[_-]|$)/i.test(c.locale_id || c.language || ''));
    if (!caption?.url) throw new Error('No English subtitle file was found. Import an English .srt / .vtt file.');
    const reply = await chrome.runtime.sendMessage({ type: 'FETCH_CAPTION', url: caption.url });
    if (!reply?.ok) throw new Error(reply?.error || 'Could not download the original captions. Import the .srt / .vtt file.');
    const parsed = SubtitleCore.parseSubtitles(reply.text);
    if (!parsed.length) throw new Error('Udemy returned no timestamped captions. Import the original .srt / .vtt file.');
    return parsed;
  }
  async function translateBrowser() {
    const token = ++generation;
    const lecturePath = location.pathname;
    running = true; start.disabled = true; stop.disabled = false;
    translations.clear(); clearReady();
    if (video) video.pause();
    try {
      status.textContent = 'Preparing the complete lecture SRT file…';
      const snapshot = await timedSubtitles();
      if (token !== generation || lecturePath !== location.pathname) return;
      cues = snapshot;
      const result = await chrome.runtime.sendMessage({ type: 'WEB_START', cues: snapshot });
      if (!result?.ok) throw new Error(result?.error || 'Could not start Gemini browser translation.');
      if (token !== generation || lecturePath !== location.pathname) {
        if (result.id) chrome.runtime.sendMessage({ type: 'WEB_CANCEL', id: result.id }).catch(() => {});
        return;
      }
      let completed = result;
      browserJobId = result.id || null;
      while (!completed.done && token === generation) {
        status.textContent = method.value === 'n8n' ? 'The complete SRT is being translated on your server through n8n. No partial subtitles will be shown.' : 'The complete SRT is being translated in Gemini. Keep its tab open. No partial subtitles will be shown.';
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (token !== generation) return;
        const reply = await chrome.runtime.sendMessage({ type: 'WEB_STATUS', id: browserJobId });
        if (!reply?.ok) throw new Error(reply?.error || 'Could not read Gemini translation status.');
        if (reply.state === 'error' || reply.state === 'cancelled') throw new Error(reply.error || 'Translation stopped.');
        if (reply.state === 'done') completed = { done: true, texts: reply.texts };
        else if (reply.status) status.textContent = reply.status;
      }
      if (token !== generation) return;
      const texts = SubtitleCore.validateTranslations(completed.texts.map((text, id) => ({ id, text })), snapshot.length);
      texts.forEach((text, i) => translations.set(i, text));
      browserJobId = null;
      status.textContent = `${texts.length} / ${texts.length} subtitle lines ready${result.cached ? ' from cache' : ''}. Full SRT translation complete. Press Play to watch.`;
      announceReady(texts.length, result.cached);
    } catch (error) {
      if (token === generation) status.textContent = error.message;
    } finally {
      if (token === generation) { browserJobId = null; running = false; start.disabled = false; stop.disabled = true; }
    }
  }
  async function translateCurrent() {
    if (running) return;
    const provider = await chrome.runtime.sendMessage({ type: 'GET_PROVIDER' });
    if (!provider?.ok) throw new Error('Could not load translation settings. Reload this lecture.');
    if (running) return;
    showMethod(provider.provider);
    if (provider.provider !== 'api') return translateBrowser();
    if (running) return;
    if (!cues.length) await discover();
    if (!cues.length || running) return;
    const token = ++generation;
    const snapshot = cues.slice();
    running = true; start.disabled = true; stop.disabled = false;
    clearReady();
    const batches = [];
    for (let i = 0; i < snapshot.length; i += 24) batches.push(i);
    const current = Math.max(0, snapshot[0]?.transcript ? transcriptIndex() : snapshot.findIndex(c => c.end > (video?.currentTime || 0)));
    const first = Math.floor(current / 24) * 24;
    batches.sort((a, b) => (a < first ? 1 : 0) - (b < first ? 1 : 0) || a - b);
    let completed = 0, cached = 0, providerNote = '';
    try {
      for (const offset of batches) {
        if (token !== generation) return;
        status.textContent = `Translating… ${completed} / ${snapshot.length} lines (24 lines/request; API requests spaced 30s)`;
        const batch = snapshot.slice(offset, offset + 24);
        const reply = await chrome.runtime.sendMessage({ type: 'TRANSLATE', texts: batch.map(c => c.text) });
        if (token !== generation) return;
        if (!reply?.ok) throw new Error(reply?.error || 'Could not connect to the extension. Reload the page.');
        if (reply.model) providerNote = ` Model: ${reply.model}${reply.fallback ? ' (fallback)' : ''}.${!reply.cached && Number.isInteger(reply.keyIndex) ? ` Key ${reply.keyIndex + 1}/${reply.keyCount}.` : ''}`;
        reply.texts.forEach((text, i) => translations.set(offset + i, text));
        completed += batch.length; if (reply.cached) cached += batch.length;
      }
      status.textContent = `${completed} subtitle lines ready. ${cached} loaded from cache.${providerNote}`;
      announceReady(completed, cached === completed);
    } catch (error) {
      if (token === generation) status.textContent = `${error.message} Completed translations have been saved.`;
    } finally {
      if (token === generation) { running = false; start.disabled = false; stop.disabled = true; }
    }
  }
  start.addEventListener('click', () => { autoStarted = true; translateCurrent().catch(error => { status.textContent = error.message; }); });
  stop.addEventListener('click', () => { autoStarted = true; cancel(); status.textContent = 'Stopped for this lecture. Automatic translation will resume on the next lecture.'; });
  scan.addEventListener('click', () => { if (!running) discover().catch(() => { status.textContent = 'Could not find subtitles. Try again.'; }); });
  hide.addEventListener('click', () => setPanelOpen(false, true));
  toggle.addEventListener('change', () => { visible = toggle.checked; applyPreferences(); });
  file.addEventListener('change', async () => {
    const selected = file.files[0]; if (!selected) return;
    fileName.textContent = selected.name;
    autoStarted = true; cancel(); const token = generation;
    if (selected.size > 5 * 1024 * 1024) { status.textContent = 'Choose a file smaller than 5 MB.'; return; }
    try {
      const parsed = SubtitleCore.parseSubtitles(await selected.text());
      if (token !== generation) return;
      if (!parsed.length) throw new Error('No timestamped subtitles found in the file.');
      cues = parsed; translations.clear(); clearReady(); imported = true;
      status.textContent = `Imported ${cues.length} subtitle lines. Make sure the file matches this video.`;
    } catch (error) { status.textContent = error.message; }
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'SHOW_PANEL') setPanelOpen(true);
    if (message?.type === 'BROWSER_MODEL_CHANGED') browserModelChanged();
    if (message?.type === 'MODEL_CHANGED') {
      refreshMethod().catch(() => {});
      cancel(); translations.clear(); clearReady(); autoStarted = false; autoAttempts = 0; nextAutoAt = Date.now();
      overlay.style.display = 'none';
      status.textContent = 'Model settings changed. Preparing subtitles…';
    }
  });
  function browserModelChanged() {
    cancel(); translations.clear(); clearReady(); overlay.style.display = 'none'; autoStarted = true;
    refreshMethod().catch(() => {});
    status.textContent = 'Model ပြောင်းပြီးပါပြီ။ Translate ပြန်နှိပ်ပါ။';
  }
  async function ensureEnglish() {
    const menu = document.querySelector('[data-purpose="captions-dropdown-menu"]');
    const choices = Array.from(menu?.querySelectorAll('[role="menuitemradio"]') || []);
    const englishChoice = choices.find(node => /^English$/i.test(node.textContent.trim())) || choices.find(node => /^English\s/i.test(node.textContent.trim()));
    if (englishChoice && englishChoice.getAttribute('aria-checked') !== 'true') englishChoice.click();
  }
  async function automaticTranslation() {
    if (!settingsReady || !preferences.autoTranslate || autoStarted || autoBusy || imported || running || discovering || !video || Date.now() < nextAutoAt) return;
    autoBusy = true;
    const lesson = sourceUrl, currentVideo = video;
    try {
      await ensureEnglish();
      if (sourceUrl !== lesson || video !== currentVideo) return;
      if (!cues.length) await discover();
      if (sourceUrl !== lesson || video !== currentVideo || !preferences.autoTranslate || autoStarted) return;
      if (cues.length) { autoStarted = true; await translateCurrent(); }
      else {
        autoAttempts++;
        nextAutoAt = Date.now() + 5000;
        if (autoAttempts >= 3) autoStarted = true;
      }
    } catch (error) { autoStarted = true; status.textContent = error.message; }
    finally { autoBusy = false; }
  }
  setInterval(() => {
    const next = Array.from(document.querySelectorAll('video')).find(v => v.getBoundingClientRect().width > 150) || null;
    const nextSource = next?.currentSrc || '';
    if (location.pathname !== sourceUrl || next !== video || nextSource !== mediaSource) {
      reset(); sourceUrl = location.pathname; video = next; mediaSource = nextSource;
    }
    automaticTranslation();
    if (!video || !visible) { overlay.style.display = 'none'; return; }
    if (!cues.length && !imported && !running && Date.now() - lastScan > 2000) {
      lastScan = Date.now(); const found = readTrack();
      if (found.length) { cues = found; status.textContent = `Found ${cues.length} English subtitle lines. Click Translate.`; }
    }
    const time = video.currentTime;
    const active = [];
    // Include overlapping cues and remove captions during silent gaps and after seeking.
    if (cues[0]?.transcript) {
      const index = transcriptIndex();
      if (index >= 0) active.push(index);
    } else {
      for (let i = 0; i < cues.length; i++) {
        if (cues[i].start > time) break;
        if (time < cues[i].end) active.push(i);
      }
    }
    if (!active.length) { overlay.style.display = 'none'; return; }
    const fullscreen = document.fullscreenElement;
    if (fullscreen === video) { overlay.style.display = 'none'; return; }
    const parent = fullscreen || document.documentElement;
    if (overlay.parentElement !== parent) parent.append(overlay);
    const rect = video.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.bottom < 0 || rect.top > innerHeight) { overlay.style.display = 'none'; return; }
    overlay.style.display = 'block'; overlay.style.left = `${rect.left}px`; overlay.style.width = `${rect.width}px`;
    const text = active.map(i => translations.get(i) || '').filter(Boolean).join('\n');
    if (!text) { overlay.style.display = 'none'; return; }
    burmese.textContent = text;
    // Keep the whole caption inside the video, even at either end of the slider.
    const bottom = Math.max(rect.top + Math.min(overlay.offsetHeight + 8, rect.height - 8), Math.min(rect.bottom - 8, rect.bottom - rect.height * preferences.verticalPosition / 100));
    overlay.style.top = `${bottom}px`; overlay.style.transform = 'translateY(-100%)';
  }, 250);
})();
