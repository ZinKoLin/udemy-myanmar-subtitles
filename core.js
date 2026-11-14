(function (root) {
  const revision = 'myanmar-v1';
  function timestamp(value) {
    const parts = value.replace(',', '.').split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return NaN;
    return parts.reduce((total, n) => total * 60 + n, 0);
  }
  function clean(value) {
    return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
  }
  function parseSubtitles(text) {
    const cues = [];
    for (const block of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.trim().split('\n');
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
      const index = lines.findIndex(line => line.includes('-->'));
      if (index < 0) continue;
      const [a, b] = lines[index].split('-->').map(s => s.trim().split(/\s/)[0]);
      const start = timestamp(a), end = timestamp(b || '');
      const content = clean(lines.slice(index + 1).join('\n'));
      if (Number.isFinite(start) && Number.isFinite(end) && end > start && content) cues.push({ start, end, text: content });
    }
    return cues.sort((a, b) => a.start - b.start);
  }
  function validateTranslations(data, length) {
    if (!Array.isArray(data) || data.length !== length) throw new Error('Translation line count does not match. Try again.');
    const result = new Array(length);
    for (const item of data) {
      if (!Number.isInteger(item.id) || item.id < 0 || item.id >= length || result[item.id] !== undefined || typeof item.text !== 'string' || !item.text.trim()) throw new Error('Invalid translation response. Try again.');
      result[item.id] = item.text.trim();
    }
    return result;
  }
  function captionIndex(cues, caption, previous = -1) {
    const normalize = text => String(text).normalize('NFC').replace(/\s+/g, ' ').trim();
    const target = normalize(caption);
    if (!target) return -1;
    const matches = [];
    cues.forEach((cue, i) => { if (normalize(cue.text) === target) matches.push(i); });
    if (matches.includes(previous)) return previous;
    return matches.reduce((best, i) => best < 0 || Math.abs(i - previous) < Math.abs(best - previous) ? i : best, -1);
  }
  function preferences(value = {}) {
    return {
      autoTranslate: value.autoTranslate !== false,
      fontSize: Number.isFinite(Number(value.fontSize)) ? Math.min(48, Math.max(16, Number(value.fontSize))) : 26,
      fontColor: /^#[0-9a-f]{6}$/i.test(value.fontColor || '') ? value.fontColor : '#ffffff',
      verticalPosition: Number.isFinite(Number(value.verticalPosition)) ? Math.min(100, Math.max(0, Number(value.verticalPosition))) : 20
    };
  }
  function modelPolicy(settings = {}) {
    const primary = settings.model || 'gemini-3.5-flash-lite';
    const fallbacks = Array.isArray(settings.fallbackModels) ? settings.fallbackModels : ['gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];
    const models = [...new Set([primary, ...(settings.autoModelFallback === false ? [] : fallbacks)].filter(Boolean))];
    if (models.some(model => typeof model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(model))) throw new Error('Enter valid model IDs.');
    return { primary, models: models.slice(0, 3) };
  }
  const api = { revision, parseSubtitles, validateTranslations, captionIndex, preferences, modelPolicy };
  root.SubtitleCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
