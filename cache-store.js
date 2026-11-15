// Only translation:* values are disposable. Settings and the current lecture are never eviction targets.
const TranslationCache = (() => {
  const indexKey = 'translationCacheIndexV1', pinsKey = 'translationCachePinsV1';
  const budget = 4 * 1024 * 1024, ttl = 30 * 86400000;
  let index, pins, serial = Promise.resolve();
  const run = action => { const result = serial.catch(() => {}).then(action); serial = result; return result; };
  const lecture = url => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return ''; } };
  const bytes = (key, value) => new TextEncoder().encode(key + JSON.stringify(value)).byteLength;
  async function load() {
    if (index) return;
    // One migration scan per worker lifetime; retain metadata only, never the cached text in RAM.
    const all = await chrome.storage.local.get(null);
    index = all[indexKey] || {}; pins = all[pinsKey] || {};
    for (const key of Object.keys(index)) if (!key.startsWith('translation:') || !(key in all)) delete index[key];
    for (const [key, value] of Object.entries(all)) if (key.startsWith('translation:')) {
      index[key] = { used: index[key]?.used || Date.now(), bytes: bytes(key, value) };
    }
    // Preserve the lecture already displayed by the previous extension version.
    const job = all.browserSubtitleJob;
    if (job?.cacheKey && Number.isInteger(job.ownerTab) && job.ownerUrl) pin(job.cacheKey, { tab: { id: job.ownerTab }, url: job.ownerUrl });
  }
  function pin(key, sender) {
    if (!Number.isInteger(sender?.tab?.id) || !sender.url) return;
    const id = String(sender.tab.id), url = lecture(sender.url);
    if (pins[id]?.url !== url) pins[id] = { url, keys: [] };
    if (!pins[id].keys.includes(key)) pins[id].keys.push(key);
  }
  async function save() {
    try { await chrome.storage.local.set({ [indexKey]: index, [pinsKey]: pins }); }
    catch { /* A full metadata store must not prevent reading the current cached subtitles.
      After restart, unknown live lectures conservatively defer eviction. */ }
  }
  async function prune(reserve = 0, allUnused = false, reserveEntries = 0) {
    const tabs = await chrome.tabs.query({ url: ['https://*.udemy.com/*', 'https://udemy.com/*', 'https://www.coursera.org/*', 'https://coursera.org/*'] });
    const live = new Map(tabs.map(tab => [String(tab.id), lecture(tab.url)]));
    for (const id of Object.keys(pins)) if (pins[id].url !== live.get(id)) delete pins[id];
    // Old content scripts may still be displaying a lecture whose cache has not registered yet.
    // Wait for registration or tab closure instead of risking deletion of its subtitles.
    if (tabs.some(tab => pins[String(tab.id)]?.url !== lecture(tab.url))) return [];
    const protectedKeys = new Set(Object.values(pins).flatMap(pin => pin.keys));
    let size = Object.values(index).reduce((sum, item) => sum + item.bytes, 0) + reserve;
    let count = Object.keys(index).length + reserveEntries;
    const remove = [];
    for (const [key, item] of Object.entries(index).sort((a, b) => a[1].used - b[1].used)) {
      if (protectedKeys.has(key)) continue;
      if (allUnused || size > budget || count > 500 || Date.now() - item.used > ttl) { remove.push(key); size -= item.bytes; count--; }
    }
    if (remove.length) await chrome.storage.local.remove(remove);
    for (const key of remove) delete index[key];
    return remove;
  }
  return {
    get(key, sender) { return run(async () => {
      await load(); pin(key, sender);
      const value = (await chrome.storage.local.get(key))[key];
      if (value !== undefined) index[key] = { used: Date.now(), bytes: bytes(key, value) };
      await save(); return value;
    }); },
    put(key, value, sender) { return run(async () => {
      if (!key.startsWith('translation:')) throw new Error('Unsupported cache key.');
      await load(); pin(key, sender);
      const size = bytes(key, value);
      await prune(Math.max(0, size - (index[key]?.bytes || 0)), false, index[key] ? 0 : 1);
      await chrome.storage.local.set({ [key]: value });
      index[key] = { used: Date.now(), bytes: size }; await save();
    }); },
    cleanup(allUnused = false) { return run(async () => { await load(); const removed = await prune(0, allUnused); await save(); return removed.length; }); }
  };
})();
