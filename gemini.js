// Only loaded in the extension service worker. Credentials never enter page messages.
const GeminiProvider = (() => {
  let queue = Promise.resolve();
  const requestInterval = 30000;
  async function waitForRequestSlot() {
    // Persist the next slot so restarting the MV3 worker cannot bypass the limit.
    let next = Number((await chrome.storage.local.get('geminiNextRequestAt')).geminiNextRequestAt) || 0;
    next = Math.min(next, Date.now() + requestInterval);
    while (next > Date.now()) {
      await new Promise(resolve => setTimeout(resolve, Math.min(10000, next - Date.now())));
      // Extension API activity keeps the worker alive during a queued request.
      await chrome.storage.local.get('geminiNextRequestAt');
    }
    await chrome.storage.local.set({ geminiNextRequestAt: Date.now() + requestInterval });
  }
  async function hash(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  }
  function normalizeKeys(settings) {
    const source = Array.isArray(settings.apiKeys) ? settings.apiKeys : [settings.apiKey];
    return [...new Set(source.filter(key => typeof key === 'string').map(key => key.trim()).filter(Boolean))].slice(0, 8);
  }
  function cooldownMilliseconds(response, body, now) {
    const header = response.headers?.get('Retry-After');
    let duration = Number(header) > 0 ? Number(header) * 1000 : Date.parse(header || '') - now;
    const retry = body?.error?.details?.find(detail => typeof detail.retryDelay === 'string')?.retryDelay;
    if (retry && /^\d+(\.\d+)?s$/.test(retry)) duration = Math.max(Number.isFinite(duration) ? duration : 0, parseFloat(retry) * 1000);
    // A short default prevents repeated calls when the API gives no retry time.
    return Math.min(86400000, Math.max(1000, Number.isFinite(duration) && duration > 0 ? duration : 60000));
  }
  async function request(path, init = {}, model = '__models__') {
    const run = queue.then(() => requestOnce(path, init, model));
    queue = run.catch(() => {});
    return run;
  }
  async function requestOnce(path, init, model) {
    const settings = await chrome.storage.local.get(['apiKeys', 'apiKey', 'autoRotate', 'activeKeyHash', 'keyCooldowns']);
    const keys = normalizeKeys(settings);
    if (!keys.length) throw new Error('Open the extension and add at least one Gemini API key.');
    const hashes = await Promise.all(keys.map(hash));
    const start = Math.max(0, hashes.indexOf(settings.activeKeyHash));
    const order = settings.autoRotate === false ? [start] : keys.map((_, i) => (i + start) % keys.length);
    const cooldowns = Object.fromEntries(Object.entries(settings.keyCooldowns || {}).filter(([key, value]) => typeof value?.until === 'number' && value.until > Date.now() && hashes.some(h => key.startsWith(h + ':'))));
    let lastCode = 429;
    for (const index of order) {
      const fingerprint = hashes[index];
      const scope = `${fingerprint}:${model}`;
      const paused = cooldowns[`${fingerprint}:*`]?.until > Date.now() ? cooldowns[`${fingerprint}:*`] : cooldowns[scope];
      if (paused?.until > Date.now()) { lastCode = paused.code; continue; }
      await waitForRequestSlot();
      let response, body;
      const signal = init.signal || AbortSignal.timeout(90000);
      const keepAlive = setInterval(() => { chrome.storage.local.get('geminiNextRequestAt').catch(() => {}); }, 10000);
      try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${path}`, {
          ...init, signal, headers: { ...init.headers, 'x-goog-api-key': keys[index] }
        });
        try { body = await response.json(); }
        catch (error) {
          if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
          throw new Error('Could not read the Gemini response. Try again.');
        }
      } catch (cause) {
        const timeout = signal.aborted || cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
        const error = new Error(timeout ? 'Gemini took longer than 90 seconds. Try again or choose a faster model.' : response ? 'Could not read the Gemini response. Try again.' : 'Could not connect to Gemini. Check your internet connection and try again.');
        error.kind = timeout ? 'timeout' : 'network';
        throw error;
      } finally { clearInterval(keepAlive); }
      if (response.ok) {
        delete cooldowns[scope];
        await chrome.storage.local.set({ activeKeyHash: fingerprint, keyCooldowns: cooldowns, lastGeminiRequest: { keyIndex: index, keyCount: keys.length, model, at: Date.now() } });
        return { body, keyIndex: index, keyCount: keys.length };
      }
      lastCode = response.status;
      const invalidKey = response.status === 400 && /API_KEY_INVALID|API key not valid/i.test(JSON.stringify(body?.error || {}));
      if (response.status === 429 || response.status === 401 || response.status === 403 || invalidKey) {
        const until = Date.now() + (response.status === 429 ? cooldownMilliseconds(response, body, Date.now()) : 600000);
        cooldowns[response.status === 429 ? scope : `${fingerprint}:*`] = { until, code: response.status };
        await chrome.storage.local.set({ keyCooldowns: cooldowns });
        continue;
      }
      const detail = response.status === 404 ? 'Model unavailable. Choose another model in settings.' : response.status === 400 ? 'Check the selected model and request settings.' : 'Try again later.';
      const error = new Error(`Gemini HTTP ${response.status} — ${detail}`);
      error.kind = response.status === 404 ? 'model-unavailable' : 'request';
      throw error;
    }
    const remaining = order.map(i => Math.max(cooldowns[`${hashes[i]}:${model}`]?.until || 0, cooldowns[`${hashes[i]}:*`]?.until || 0) - Date.now()).filter(n => n > 0);
    const seconds = remaining.length ? Math.ceil(Math.min(...remaining) / 1000) : 60;
    const error = new Error(`Gemini HTTP ${lastCode} — ${settings.autoRotate === false ? 'The active key is unavailable.' : 'All saved keys are limited or unavailable.'} Try again in ${seconds}s. Keys in the same Google project share quota.`);
    error.kind = order.some(i => cooldowns[`${hashes[i]}:${model}`]?.code === 429 && cooldowns[`${hashes[i]}:${model}`].until > Date.now()) ? 'quota' : 'key';
    throw error;
  }
  async function listModels() {
    const models = [];
    let token = '';
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ pageSize: '1000' });
      if (token) query.set('pageToken', token);
      const { body } = await request(`models?${query}`);
      for (const model of body.models || []) {
        const id = model.name?.replace(/^models\//, '');
        if (/^gemini-[a-zA-Z0-9._-]+$/.test(id || '') && model.supportedGenerationMethods?.includes('generateContent') && !/image|tts|audio|live|robotics|computer-use/i.test(id)) models.push({ id, label: model.displayName || id });
      }
      token = body.nextPageToken;
      if (!token) return [...new Map(models.map(model => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    throw new Error('The model list is too large. Enter a custom model ID instead.');
  }
  return { request, listModels, normalizeKeys };
})();
