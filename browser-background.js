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
async function webRememberDraft(job, prompt, responseId) {
  const saved = (await chrome.storage.local.get('geminiOwnedDrafts')).geminiOwnedDrafts || [];
  const hash = await digest(prompt.replace(/\s+/g, ' ').trim());
  const record = { tabId: job.geminiTab, responseId, hash, fileBase: `udemy-${job.id}` };
  await chrome.storage.local.set({ geminiOwnedDrafts: [...saved.filter(x => x.hash !== hash), record].slice(-16) });
}
// Keep the conversation identity separate from its replaceable browser tab.
function webChatUrl(value, accountIndex) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://gemini.google.com' && !url.username && !url.password && new RegExp(`^/u/${accountIndex}/app(?:/[a-zA-Z0-9_-]+)?$`).test(url.pathname)) return url.origin + url.pathname;
  } catch {}
  return null;
}
function webConversation(value, accountIndex) {
  const url = webChatUrl(value, accountIndex);
  return url && url !== `https://gemini.google.com/u/${accountIndex}/app` ? url : null;
}
async function webRememberConversation(tabId, value) {
  const session = (await chrome.storage.local.get('geminiBrowserSession')).geminiBrowserSession;
  if (session?.tabId !== tabId || webConversation(session.chatUrl, session.accountIndex)) return;
  const chatUrl = webConversation(value, session.accountIndex);
  if (chatUrl && chatUrl !== session.retiredChatUrl) {
    await chrome.storage.local.set({ geminiBrowserSession: { ...session, chatUrl } });
    const job = await webRead();
    if (job?.geminiTab === tabId && !webConversation(job.conversationUrl, job.accountIndex)) { job.conversationUrl = chatUrl; job.chatProbe = false; await webSave(job); }
  }
}
// Gemini may assign the conversation URL after the completed adapter stops polling.
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  webSerial(async () => {
    const session = (await chrome.storage.local.get('geminiBrowserSession')).geminiBrowserSession;
    const tab = await chrome.tabs.get(tabId);
    if (session?.tabId === tabId || (tab.active && /^https:\/\/gemini\.google\.com\//.test(tab.url || ''))) chrome.tabs.sendMessage(tabId, { type: 'BROWSER_ACCOUNT_CHECK' }).catch(() => {});
    const job = await webRead();
    if (job?.mode !== 'n8n' && job?.geminiTab === tabId && ['waiting', 'done'].includes(job.state)) await webRememberConversation(tabId, changeInfo.url);
  }).catch(() => {});
});
chrome.tabs.onActivated?.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(tab => {
    if (/^https:\/\/gemini\.google\.com\//.test(tab.url || '')) return chrome.tabs.sendMessage(tabId, { type: 'BROWSER_ACCOUNT_CHECK' });
  }).catch(() => {});
});
function webOwner(job, sender) { return job && job.ownerTab === sender.tab?.id && job.ownerUrl === sender.url?.split('#')[0]; }
function webGemini(job, sender) {
  try { return job && sender.tab?.id === job.geminiTab && new URL(sender.url).origin === 'https://gemini.google.com'; } catch { return false; }
}
async function webHandle(message, sender) {
  await ready;
  if (message.type === 'WEB_ACCOUNT') {
    const saved = await chrome.storage.local.get(['translationProvider', 'geminiBrowserSession', 'geminiAccountIndex', 'geminiAccountEmail', 'geminiAccountSessions']);
    const session = saved.geminiBrowserSession;
    // Account switching can open a new tab. Follow the actively selected Gemini tab,
    // while background tabs cannot replace the user's choice.
    if ((saved.translationProvider && saved.translationProvider !== 'browser') || !session || !sender.tab?.id) return { adopted: false };
    const liveTab = await chrome.tabs.get(sender.tab.id);
    if (session.tabId !== sender.tab.id && !liveTab.active) return { adopted: false };
    const accountPath = value => {
      try { const u = new URL(value); return u.origin === 'https://gemini.google.com' ? u.pathname.match(/^\/(?:u\/(\d+)\/)?app(?:\/[a-zA-Z0-9_-]+)?$/) : null; } catch { return null; }
    };
    const path = accountPath(sender.url);
    const current = accountPath(liveTab.url);
    const index = path ? Number(path[1] || 0) : -1;
    const email = typeof message.email === 'string' ? message.email.trim().toLowerCase() : '';
    if (!path || !current || index !== Number(current[1] || 0) || index > 20 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { adopted: false };
    if (saved.geminiAccountIndex === index && saved.geminiAccountEmail === email) return { adopted: true, changed: false };
    const history = (Array.isArray(saved.geminiAccountSessions) ? saved.geminiAccountSessions : []).filter(x => x.email !== session.email || x.accountIndex !== session.accountIndex);
    history.push(session);
    const previous = history.find(x => x.email === email && x.accountIndex === index);
    const chatUrl = webChatUrl(previous?.chatUrl, index) || `https://gemini.google.com/u/${index}/app`;
    const job = await webRead();
    if (job?.mode !== 'n8n' && job?.geminiTab === session.tabId && ['preparing', 'ready', 'repair-ready', 'waiting'].includes(job.state)) {
      job.state = 'error'; job.error = 'Gemini အကောင့်ပြောင်းပြီးပါပြီ။ ရွေးထားသောအကောင့်အသစ်ဖြင့် Translate ပြန်နှိပ်ပါ။'; job.srt = ''; job.cues = []; job.updated = Date.now(); await webSave(job);
    }
    await chrome.storage.local.set({ geminiAccountIndex: index, geminiAccountEmail: email, geminiAccountSessions: history.slice(-8), geminiBrowserSession: { tabId: sender.tab.id, accountIndex: index, email, chatUrl } });
    return { adopted: true, changed: true };
  }
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
    if (old && ['preparing', 'ready', 'repair-ready', 'waiting'].includes(old.state)) {
      if (webOwner(old, sender) && old.cacheKey === cacheKey && (remote ? old.mode === 'n8n' : old.expectedEmail === geminiAccountEmail.toLowerCase() && old.accountIndex === geminiAccountIndex)) {
        if (old.mode !== 'n8n' && old.geminiTab) {
          try { const awake = await chrome.tabs.sendMessage(old.geminiTab, { type: 'BROWSER_JOB_AVAILABLE' }); if (!awake?.ok) await chrome.tabs.reload(old.geminiTab); }
          catch { try { await chrome.tabs.reload(old.geminiTab); } catch {} }
        }
        return { id: old.id };
      }
      if (old.mode === 'n8n' && old.ownerTab === sender.tab.id) {
        try { await n8nRequest(old.connection, { action: 'cancel', id: old.id }); } catch { /* Local method switching must still work when the server is offline. Late remote answers are never applied. */ }
      }
      if (old.ownerTab !== sender.tab.id && Date.now() - old.created < 20 * 60 * 1000) {
        let exists = true; try { await chrome.tabs.get(old.ownerTab); } catch { exists = false; }
        if (exists) throw new Error('Another full SRT translation is running. Stop it in its lesson tab first.');
      }
    }
    const id = crypto.randomUUID().replace(/-/g, '');
    const job = { id, ownerTab: sender.tab.id, ownerUrl: sender.url.split('#')[0], cues, srt, cacheKey, expectedEmail: geminiAccountEmail?.toLowerCase(), accountIndex: geminiAccountIndex, mode: remote ? 'n8n' : 'browser', connection: remote, browserModel, protocol: 2, repairs: 0, recovery: true, state: 'preparing', created: Date.now(), updated: Date.now() };
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
          if (webChatUrl(url.href, geminiAccountIndex)) savedSession = { tabId: previous.id, accountIndex: geminiAccountIndex, email: job.expectedEmail, chatUrl: url.origin + url.pathname };
        } catch {}
      }
      const sameAccount = savedSession?.email === job.expectedEmail && savedSession?.accountIndex === geminiAccountIndex;
      let chatUrl = base;
      if (sameAccount && savedSession.chatUrl) {
        chatUrl = webChatUrl(savedSession.chatUrl, geminiAccountIndex) || base;
      }
      let tab, reused = false;
      if (sameAccount && savedSession.tabId) {
        try {
          const existing = await chrome.tabs.get(savedSession.tabId);
          const current = new URL(existing.url);
          const currentUrl = webChatUrl(current.href, geminiAccountIndex);
          const pinned = webConversation(chatUrl, geminiAccountIndex);
          if (currentUrl && (!pinned || currentUrl === pinned)) { tab = existing; reused = true; chatUrl = currentUrl; }
        } catch { /* Reopen the saved conversation when its tab has been closed. */ }
      }
      if (!tab) tab = await chrome.tabs.create({ url: chatUrl + '#udemy-srt=' + id, active: true });
      job.geminiTab = tab.id; job.conversationUrl = chatUrl; job.chatProbe = !reused && !!webConversation(chatUrl, geminiAccountIndex); job.state = 'ready'; job.status = 'Waiting for Gemini. Keep its tab open; sign in or select Pro if needed.';
      await webSave(job);
      await chrome.storage.local.set({ geminiBrowserSession: { tabId: tab.id, accountIndex: geminiAccountIndex, email: job.expectedEmail, chatUrl, retiredChatUrl: sameAccount ? savedSession.retiredChatUrl : undefined } });
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
  if (job && ['preparing', 'ready', 'repair-ready', 'waiting'].includes(job.state) && Date.now() - job.created > 20 * 60 * 1000) {
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
    } else if (['preparing', 'ready', 'repair-ready', 'waiting'].includes(job.state)) {
      try { await chrome.tabs.get(job.geminiTab); }
      catch { job.state = 'error'; job.error = 'The Gemini tab was closed. Click Translate to retry.'; }
      if (Date.now() - job.created > 20 * 60 * 1000) { job.state = 'error'; job.error = 'Gemini translation timed out after 20 minutes. Check its tab and retry.'; }
      if (job.state === 'error') { job.srt = ''; job.cues = []; await webSave(job); }
    }
    return { id: job.id, state: job.state, status: job.status, error: job.error, texts: job.state === 'done' ? job.texts : undefined };
  }
  if (job?.mode === 'n8n' || !webGemini(job, sender)) return { idle: true };
  if (message.type === 'WEB_TASK') {
    await webRememberConversation(job.geminiTab, (await chrome.tabs.get(job.geminiTab)).url || sender.url);
  }
  if (message.type === 'WEB_TASK') {
    // An exact owned draft can survive closing/reopening its dedicated chat tab.
    // Hash ownership is independent of the old, replaceable tab ID.
    const ownedDrafts = ((await chrome.storage.local.get('geminiOwnedDrafts')).geminiOwnedDrafts || []).slice(-16);
    const delivering = job.recovery && job.state === 'waiting' && job.delivery?.phase !== 'submitted';
    return { id: job.id, state: job.state, conversationUrl: job.conversationUrl, chatProbe: job.chatProbe, repair: !!job.repairs, expectedEmail: job.expectedEmail, accountIndex: job.accountIndex, browserModel: job.browserModel || 'argon-medium', responseId: BrowserSubtitleCore.responseId(job), repairPrompt: job.state === 'repair-ready' ? BrowserSubtitleCore.repairPrompt(job) : undefined, srt: job.state === 'ready' ? (job.protocol === 2 ? BrowserSubtitleCore.taggedSrt(job.cues) : job.srt) : undefined, prompt: job.state === 'ready' ? BrowserSubtitleCore.prompt(BrowserSubtitleCore.responseId(job), job.cues.length) : undefined, recoverySrt: delivering && !job.repairs ? BrowserSubtitleCore.taggedSrt(job.cues) : undefined, deliveryPrompt: delivering ? (job.repairs ? BrowserSubtitleCore.repairPrompt(job) : BrowserSubtitleCore.prompt(BrowserSubtitleCore.responseId(job), job.cues.length)) : undefined, recovery: job.recovery, delivery: job.delivery, ownedDrafts, error: job.error };
  }
  if (message.id !== job.id) throw new Error('Stale Gemini response.');
  if (message.type === 'WEB_BUSY' && ['ready', 'repair-ready'].includes(job.state)) {
    const status = 'Gemini ၏ အရင်အဖြေ ပြီးသည်အထိ စောင့်နေပါသည်။ လက်ရှိ SRT ကို ထပ်မပို့သေးပါ။';
    if (job.status !== status) { job.status = status; await webSave(job); }
    return {};
  }
  if (message.type === 'WEB_CHAT_MISSING' && job.recovery && ['ready', 'repair-ready', 'waiting'].includes(job.state)) {
    const session = (await chrome.storage.local.get('geminiBrowserSession')).geminiBrowserSession;
    const expected = webConversation(job.conversationUrl, job.accountIndex);
    const current = webChatUrl((await chrome.tabs.get(job.geminiTab)).url, job.accountIndex);
    const base = `https://gemini.google.com/u/${job.accountIndex}/app`;
    if (!expected || message.conversationUrl !== expected || session?.tabId !== job.geminiTab || session.chatUrl !== expected || session.email !== job.expectedEmail) return { claimed: false };
    if (message.reason === 'redirected-empty' ? !(job.chatProbe && current === base) : message.reason !== 'not-found' || current !== expected) return { claimed: false };
    if ((job.chatRecoveries || 0) >= 1) throw new Error('Gemini chat အသစ်ဖြင့် တစ်ကြိမ်ပြန်စပြီး မအောင်မြင်ပါ။ Login နှင့် Gemini အခြေအနေကို စစ်ပါ။');
    job.chatRecoveries = (job.chatRecoveries || 0) + 1;
    job.repairs = 0; job.state = 'ready'; job.srt = BrowserSubtitleCore.toSrt(job.cues);
    delete job.delivery; delete job.errorRetries; delete job.retryAt;
    job.conversationUrl = base; job.chatProbe = false; job.updated = Date.now();
    job.status = 'မူလ Gemini chat မရှိတော့သဖြင့် chat အသစ်တစ်ခုဖြင့် အလိုအလျောက် ပြန်ဘာသာပြန်နေပါသည်။';
    await chrome.storage.local.set({ geminiBrowserSession: { ...session, chatUrl: base, retiredChatUrl: expected } });
    await webSave(job);
    if (current !== base) await chrome.tabs.update(job.geminiTab, { url: base + '#udemy-srt=' + job.id });
    return { claimed: true };
  }
  if (message.type === 'WEB_SENT' && job.state === 'ready') {
    if (job.recovery) {
      await webRememberDraft(job, BrowserSubtitleCore.prompt(BrowserSubtitleCore.responseId(job), job.cues.length), BrowserSubtitleCore.responseId(job));
      job.delivery = { phase: 'claimed', uploads: 0, sends: 0, clientId: message.clientId, leaseUntil: Date.now() + 120000 };
    }
    job.state = 'waiting'; job.srt = ''; job.status = 'The whole SRT is being translated in Gemini. Waiting for the complete reply…'; job.updated = Date.now(); await webSave(job); return { claimed: true };
  }
  if (message.type === 'WEB_REPAIR_SENT' && job.state === 'repair-ready') {
    if (job.recovery) { await webRememberDraft(job, BrowserSubtitleCore.repairPrompt(job), BrowserSubtitleCore.responseId(job)); job.delivery = { phase: 'claimed', uploads: 0, sends: 0, clientId: message.clientId, leaseUntil: Date.now() + 120000 }; }
    job.state = 'waiting'; job.updated = Date.now(); await webSave(job); return { claimed: true };
  }
  if (message.type === 'WEB_DELIVERY' && job.recovery && job.state === 'waiting') {
    if (message.responseId !== BrowserSubtitleCore.responseId(job)) throw new Error('Stale Gemini delivery.');
    const delivery = job.delivery ||= { phase: 'claimed', uploads: 0, sends: 0 };
    if (delivery.phase === 'submitted') return { claimed: false, submitted: true };
    if (message.stage !== 'ack' && delivery.clientId && delivery.clientId !== message.clientId && delivery.leaseUntil > Date.now()) return { claimed: false, busy: true };
    if (message.stage === 'upload' || message.stage === 'send') {
      const counter = message.stage === 'upload' ? 'uploads' : 'sends';
      if (delivery[counter] >= 2) throw new Error('Gemini သို့ ပို့မှု နှစ်ကြိမ် မအောင်မြင်ပါ။ စာတန်းကို မပြသေးပါ။');
      delivery[counter]++; delivery.phase = message.stage === 'upload' ? 'uploading' : 'sending'; delivery.clientId = message.clientId; delivery.leaseUntil = Date.now() + 120000;
    } else if (message.stage === 'ack') delivery.phase = 'submitted';
    else throw new Error('Unknown delivery stage.');
    job.status = message.stage === 'ack' ? 'SRT ပို့ပြီးပါပြီ။ Gemini ပြန်စာအပြည့်ကို စောင့်နေပါသည်။' : 'SRT ဖိုင်တင်မှုနှင့် ပို့ပြီးကြောင်း အတည်ပြုနေပါသည်။';
    job.updated = Date.now(); await webSave(job); return { claimed: true, delivery };
  }
  if (message.type === 'WEB_RETRY' && job.recovery && job.state === 'waiting') {
    if (message.responseId !== BrowserSubtitleCore.responseId(job)) throw new Error('Stale Gemini retry.');
    if (job.retryAt && Date.now() - job.retryAt < 30000) return { claimed: false };
    if ((job.errorRetries || 0) >= 2) throw new Error('Gemini ယာယီ error ကို နှစ်ကြိမ် အလိုအလျောက် ပြန်စမ်းပြီး မအောင်မြင်ပါ။ စာတန်းကို မပြသေးပါ။');
    job.errorRetries = (job.errorRetries || 0) + 1; job.retryAt = Date.now();
    job.status = `Gemini ယာယီ error ဖြစ်သဖြင့် အလိုအလျောက် ပြန်စမ်းနေပါသည် (${job.errorRetries}/2)။`;
    await webSave(job); return { claimed: true, attempt: job.errorRetries };
  }
  if (message.type === 'WEB_RESULT' && job.state === 'waiting') {
    if (message.responseId && message.responseId !== BrowserSubtitleCore.responseId(job)) return { ignored: true };
    if (typeof message.raw !== 'string' || message.raw.length > 4000000) throw new Error('Invalid Gemini response.');
    let texts;
    try { texts = BrowserSubtitleCore.parseReply(message.raw, BrowserSubtitleCore.responseId(job), job.cues, job.protocol === 2); }
    catch (error) {
      if ((job.repairs || 0) >= 1) throw new Error('Gemini က စာတန်း ID များကို မပြည့်အောင် ပြန်ပေးနေပါသည်။ အလိုအလျောက် တစ်ကြိမ်ပြန်စပြီး မအောင်မြင်ပါ။ Model ပြောင်းပြီး Translate ပြန်နှိပ်ပါ။');
      job.repairs = 1; job.protocol = 2; job.state = 'repair-ready'; job.status = 'စာတန်း ID မပြည့်သဖြင့် မူရင်းစာသားဖြင့် တစ်ကြိမ်ပြန်ဘာသာပြန်နေပါသည်။'; job.updated = Date.now(); await webSave(job); return { repair: true };
    }
    await TranslationCache.put(job.cacheKey, texts, { tab: { id: job.ownerTab }, url: job.ownerUrl });
    job.state = 'done'; job.texts = texts; job.srt = ''; job.cues = []; job.updated = Date.now(); await webSave(job); return { done: true };
  }
  if (message.type === 'WEB_ERROR' && ['ready', 'repair-ready', 'waiting'].includes(job.state)) {
    if (message.responseId && message.responseId !== BrowserSubtitleCore.responseId(job)) return { ignored: true };
    job.state = 'error'; job.error = typeof message.error === 'string' ? message.error.slice(0, 300) : 'Gemini browser translation failed.';
    job.srt = ''; job.cues = []; job.updated = Date.now(); await webSave(job); return {};
  }
  return { idle: true };
}
function browserMessage(message, sender, respond) {
  if (sender.id !== chrome.runtime.id || !message || !['WEB_ACCOUNT', 'FETCH_CAPTION', 'GET_PROVIDER', 'SET_PROVIDER', 'SET_BROWSER_MODEL', 'WEB_START', 'WEB_STATUS', 'WEB_CANCEL', 'WEB_TASK', 'WEB_SENT', 'WEB_REPAIR_SENT', 'WEB_BUSY', 'WEB_CHAT_MISSING', 'WEB_DELIVERY', 'WEB_RETRY', 'WEB_RESULT', 'WEB_ERROR'].includes(message.type)) return false;
  let url; try { url = new URL(sender.url); } catch { return false; }
  const udemy = url.protocol === 'https:' && (url.hostname === 'udemy.com' || url.hostname.endsWith('.udemy.com'));
  const coursera = url.protocol === 'https:' && !url.port && ['coursera.org', 'www.coursera.org'].includes(url.hostname);
  const gemini = url.origin === 'https://gemini.google.com';
  if (!sender.tab || (!udemy && !coursera && !gemini)) return false;
  if (message.type === 'FETCH_CAPTION' && !udemy) return false;
  if (['FETCH_CAPTION', 'GET_PROVIDER', 'SET_PROVIDER', 'SET_BROWSER_MODEL', 'WEB_START', 'WEB_STATUS', 'WEB_CANCEL'].includes(message.type) ? !(udemy || coursera) : !gemini) return false;
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
  chrome.tabs.query({ url: ['https://*.udemy.com/*', 'https://udemy.com/*', 'https://www.coursera.org/*', 'https://coursera.org/*'] }).then(tabs => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'BROWSER_MODEL_CHANGED' }).catch(() => {});
  }).catch(() => {});
});
