// Persistent, short-message jobs survive MV3 worker suspension. No Google API requests are used here.
const webJobKey = 'browserSubtitleJob';
let webWrites = Promise.resolve();
function webSerial(action) {
  const result = webWrites.catch(() => {}).then(action);
  webWrites = result;
  return result;
}
async function webRead() { return (await chrome.storage.local.get(webJobKey))[webJobKey]; }
async function webSave(job) { await chrome.storage.local.set({ [webJobKey]: job }); }
function webOwner(job, sender) { return job && job.ownerTab === sender.tab?.id && job.ownerUrl === sender.url?.split('#')[0]; }
function webGemini(job, sender) {
  try { return job && sender.tab?.id === job.geminiTab && new URL(sender.url).origin === 'https://gemini.google.com'; } catch { return false; }
}
async function webHandle(message, sender) {
  await ready;
  if (message.type === 'WEB_START') {
    const settings = await chrome.storage.local.get(['translationProvider', 'geminiAccountIndex', 'geminiAccountEmail', 'geminiBrowserModel', 'n8nUrl', 'n8nToken']);
    const { translationProvider, geminiAccountIndex, geminiAccountEmail } = settings;
    const remote = translationProvider === 'n8n' ? n8nConnection(settings) : null;
    if (translationProvider === 'api') throw new Error('Choose Gemini browser in extension settings first.');
    if (!remote && (!Number.isInteger(geminiAccountIndex) || geminiAccountIndex < 0 || geminiAccountIndex > 20 || typeof geminiAccountEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(geminiAccountEmail))) throw new Error('Set your Pro account number and email in extension settings first.');
    const browserModel = BrowserSubtitleCore.model(settings.geminiBrowserModel);
    const srt = BrowserSubtitleCore.toSrt(message.cues);
    const cues = SubtitleCore.parseSubtitles(srt);
    const cacheKey = 'translation:browser-srt-v2:' + await digest(JSON.stringify([SubtitleCore.revision, browserModel, ...(remote ? [remote.url] : []), srt]));
    const cached = await TranslationCache.get(cacheKey, sender);
    if (cached && browserModel !== 'current') return { done: true, cached: true, texts: SubtitleCore.validateTranslations(cached.map((text, id) => ({ id, text })), cues.length) };
    const old = await webRead();
    if (old && ['preparing', 'ready', 'waiting'].includes(old.state)) {
      if (webOwner(old, sender) && old.cacheKey === cacheKey && (remote ? old.mode === 'n8n' : old.expectedEmail === geminiAccountEmail.toLowerCase() && old.accountIndex === geminiAccountIndex)) return { id: old.id };
      if (old.mode === 'n8n' && old.ownerTab === sender.tab.id) {
        try { await n8nRequest(old.connection, { action: 'cancel', id: old.id }); } catch { /* Local method switching must still work when the server is offline. Late remote answers are never applied. */ }
      }
      if (old.ownerTab !== sender.tab.id && Date.now() - old.created < 20 * 60 * 1000) {
        let exists = true; try { await chrome.tabs.get(old.ownerTab); } catch { exists = false; }
        if (exists) throw new Error('Another full SRT translation is running. Stop it in its Udemy tab first.');
      }
    }
    const id = crypto.randomUUID().replace(/-/g, '');
    const job = { id, ownerTab: sender.tab.id, ownerUrl: sender.url.split('#')[0], cues, srt, cacheKey, expectedEmail: geminiAccountEmail?.toLowerCase(), accountIndex: geminiAccountIndex, mode: remote ? 'n8n' : 'browser', connection: remote, browserModel, state: 'preparing', created: Date.now(), updated: Date.now() };
    await webSave(job);
    try {
      if (remote) {
        await n8nRequest(remote, { action: 'start', id, srt, browserModel });
        job.state = 'waiting'; job.status = 'Full SRT sent to n8n. Gemini is running on your server with the selected model.';
        await webSave(job); return { id };
      }
      const base = `https://gemini.google.com/u/${geminiAccountIndex}/app`;
      let savedSession = (await chrome.storage.local.get('geminiBrowserSession')).geminiBrowserSession;
      // Adopt the previous version's dedicated chat after an extension update.
      if (!savedSession && old?.geminiTab && old.expectedEmail === job.expectedEmail && old.accountIndex === geminiAccountIndex) {
        try {
          const previous = await chrome.tabs.get(old.geminiTab);
          const url = new URL(previous.url);
          if (url.origin === 'https://gemini.google.com' && url.pathname.startsWith(`/u/${geminiAccountIndex}/app`)) savedSession = { tabId: previous.id, accountIndex: geminiAccountIndex, email: job.expectedEmail, chatUrl: url.origin + url.pathname };
        } catch {}
      }
      const sameAccount = savedSession?.email === job.expectedEmail && savedSession?.accountIndex === geminiAccountIndex;
      let chatUrl = base;
      if (sameAccount && savedSession.chatUrl) {
        try { const url = new URL(savedSession.chatUrl); if (url.origin === 'https://gemini.google.com' && url.pathname.startsWith(`/u/${geminiAccountIndex}/app`)) chatUrl = url.origin + url.pathname; } catch {}
      }
      let tab, reused = false;
      if (sameAccount && savedSession.tabId) {
        try {
          const existing = await chrome.tabs.get(savedSession.tabId);
          const current = new URL(existing.url);
          if (current.origin === 'https://gemini.google.com' && current.pathname === new URL(chatUrl).pathname) { tab = existing; reused = true; }
        } catch { /* Reopen the saved conversation when its tab has been closed. */ }
      }
      if (!tab) tab = await chrome.tabs.create({ url: chatUrl + '#udemy-srt=' + id, active: true });
      job.geminiTab = tab.id; job.state = 'ready'; job.status = 'Waiting for Gemini. Keep its tab open; sign in or select Pro if needed.';
      await webSave(job);
      await chrome.storage.local.set({ geminiBrowserSession: { tabId: tab.id, accountIndex: geminiAccountIndex, email: job.expectedEmail, chatUrl } });
      try {
        const awake = await chrome.tabs.sendMessage(tab.id, { type: 'BROWSER_JOB_AVAILABLE' });
        if (!awake?.ok && reused) await chrome.tabs.reload(tab.id);
      } catch { if (reused) await chrome.tabs.reload(tab.id); /* A newly opened tab starts after loading. */ }
    } catch (error) { job.state = 'error'; job.error = remote ? error.message : 'Could not open Gemini. Check extension permissions and try again.'; await webSave(job); throw new Error(job.error); }
    return { id };
  }
  const job = await webRead();
  if (message.type === 'WEB_CANCEL') {
    if (job && job.ownerTab === sender.tab.id && message.id === job.id && !['done', 'error', 'cancelled'].includes(job.state)) {
      if (job.mode === 'n8n') { try { await n8nRequest(job.connection, { action: 'cancel', id: job.id }); } catch { /* Stop locally even if remote cancellation cannot be confirmed. */ } }
      job.state = 'cancelled'; job.srt = ''; job.cues = []; job.updated = Date.now(); await webSave(job);
    }
    return {};
  }
  if (job && ['preparing', 'ready', 'waiting'].includes(job.state) && Date.now() - job.created > 20 * 60 * 1000) {
    job.state = 'error'; job.error = 'Gemini translation timed out after 20 minutes. Check its tab and retry.'; job.srt = ''; job.cues = []; await webSave(job);
  }
  if (message.type === 'WEB_STATUS') {
    if (!webOwner(job, sender) || job.id !== message.id) throw new Error('This translation belongs to another lecture.');
    if (job.mode === 'n8n' && ['preparing', 'waiting'].includes(job.state)) {
      const remote = await n8nRequest(job.connection, { action: 'status', id: job.id });
      if (remote.state === 'done') {
        try {
          if (typeof remote.raw !== 'string' || remote.raw.length > 4000000) throw new Error('n8n returned an invalid subtitle response.');
          job.texts = BrowserSubtitleCore.parseReply(remote.raw, job.id, job.cues);
          await TranslationCache.put(job.cacheKey, job.texts, { tab: { id: job.ownerTab }, url: job.ownerUrl });
          job.state = 'done';
        } catch (error) { job.state = 'error'; job.error = error.message; delete job.texts; }
        job.srt = ''; job.cues = []; job.updated = Date.now(); await webSave(job);
      } else if (['error', 'cancelled'].includes(remote.state)) {
        job.state = remote.state; job.error = remote.error || 'Server translation stopped.'; job.srt = ''; job.cues = []; await webSave(job);
      } else job.status = 'n8n / server Gemini: ' + (remote.status || remote.state || 'waiting');
    } else if (['preparing', 'ready', 'waiting'].includes(job.state)) {
      try { await chrome.tabs.get(job.geminiTab); }
      catch { job.state = 'error'; job.error = 'The Gemini tab was closed. Click Translate to retry.'; }
      if (Date.now() - job.created > 20 * 60 * 1000) { job.state = 'error'; job.error = 'Gemini translation timed out after 20 minutes. Check its tab and retry.'; }
      if (job.state === 'error') { job.srt = ''; job.cues = []; await webSave(job); }
    }
    return { id: job.id, state: job.state, status: job.status, error: job.error, texts: job.state === 'done' ? job.texts : undefined };
  }
  if (job?.mode === 'n8n' || !webGemini(job, sender)) return { idle: true };
  if (message.type === 'WEB_TASK') {
    const url = new URL(sender.url);
    const session = (await chrome.storage.local.get('geminiBrowserSession')).geminiBrowserSession;
    if (session?.tabId === sender.tab.id && url.pathname.startsWith(`/u/${job.accountIndex}/app/`) && session.chatUrl !== url.origin + url.pathname) {
      await chrome.storage.local.set({ geminiBrowserSession: { ...session, chatUrl: url.origin + url.pathname } });
    }
  }
  if (message.type === 'WEB_TASK') return { id: job.id, state: job.state, expectedEmail: job.expectedEmail, accountIndex: job.accountIndex, browserModel: job.browserModel || 'argon-medium', srt: job.state === 'ready' ? job.srt : undefined, prompt: job.state === 'ready' ? BrowserSubtitleCore.prompt(job.id, job.cues.length) : undefined, error: job.error };
  if (message.id !== job.id) throw new Error('Stale Gemini response.');
  if (message.type === 'WEB_SENT' && job.state === 'ready') {
    job.state = 'waiting'; job.srt = ''; job.status = 'The whole SRT is being translated in Gemini. Waiting for the complete reply…'; job.updated = Date.now(); await webSave(job); return { claimed: true };
  }
  if (message.type === 'WEB_RESULT' && job.state === 'waiting') {
    if (typeof message.raw !== 'string' || message.raw.length > 4000000) throw new Error('Invalid Gemini response.');
    const texts = BrowserSubtitleCore.parseReply(message.raw, job.id, job.cues);
    await TranslationCache.put(job.cacheKey, texts, { tab: { id: job.ownerTab }, url: job.ownerUrl });
    job.state = 'done'; job.texts = texts; job.srt = ''; job.cues = []; job.updated = Date.now(); await webSave(job); return { done: true };
  }
  if (message.type === 'WEB_ERROR' && ['ready', 'waiting'].includes(job.state)) {
    job.state = 'error'; job.error = typeof message.error === 'string' ? message.error.slice(0, 300) : 'Gemini browser translation failed.';
    job.srt = ''; job.cues = []; job.updated = Date.now(); await webSave(job); return {};
  }
  return { idle: true };
}
function browserMessage(message, sender, respond) {
  if (sender.id !== chrome.runtime.id || !message || !['FETCH_CAPTION', 'GET_PROVIDER', 'SET_PROVIDER', 'SET_BROWSER_MODEL', 'WEB_START', 'WEB_STATUS', 'WEB_CANCEL', 'WEB_TASK', 'WEB_SENT', 'WEB_RESULT', 'WEB_ERROR'].includes(message.type)) return false;
  let url; try { url = new URL(sender.url); } catch { return false; }
  const udemy = url.protocol === 'https:' && (url.hostname === 'udemy.com' || url.hostname.endsWith('.udemy.com'));
  const gemini = url.origin === 'https://gemini.google.com';
  if (!sender.tab || (!udemy && !gemini)) return false;
  if (['FETCH_CAPTION', 'GET_PROVIDER', 'SET_PROVIDER', 'SET_BROWSER_MODEL', 'WEB_START', 'WEB_STATUS', 'WEB_CANCEL'].includes(message.type) ? !udemy : !gemini) return false;
  const action = message.type === 'FETCH_CAPTION' ? async () => {
    const target = new URL(message.url);
    if (target.protocol !== 'https:' || !(target.hostname === 'udemycdn.com' || target.hostname.endsWith('.udemycdn.com')) || target.username || target.password || (target.port && target.port !== '443')) throw new Error('Unsupported caption file host. Import the original SRT file instead.');
    const response = await fetch(target.href, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Could not download Udemy captions. Import the original SRT file instead.');
    const text = await response.text();
    if (text.length > 2000000) throw new Error('The caption file is too large.');
    return { text };
  } : ['GET_PROVIDER', 'SET_PROVIDER', 'SET_BROWSER_MODEL'].includes(message.type) ? async () => {
    await ready;
    if (message.type === 'SET_PROVIDER') {
      if (!['api', 'browser', 'n8n'].includes(message.provider)) throw new Error('Unknown translation method.');
      await chrome.storage.local.set({ translationProvider: message.provider });
    }
    if (message.type === 'SET_BROWSER_MODEL') await chrome.storage.local.set({ geminiBrowserModel: BrowserSubtitleCore.model(message.model) });
    const s = await chrome.storage.local.get(['translationProvider', 'geminiBrowserModel']);
    return { browserModel: BrowserSubtitleCore.model(s.geminiBrowserModel), provider: ['api', 'n8n'].includes(s.translationProvider) ? s.translationProvider : 'browser' };
  } : () => webHandle(message, sender);
  webSerial(action).then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
  return true;
}
// Send only the model-change signal; trusted storage remains inaccessible to content scripts.
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !changes.geminiBrowserModel) return;
  chrome.tabs.query({ url: ['https://*.udemy.com/*', 'https://udemy.com/*'] }).then(tabs => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'BROWSER_MODEL_CHANGED' }).catch(() => {});
  }).catch(() => {});
});
