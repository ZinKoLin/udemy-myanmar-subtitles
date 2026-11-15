(function (root) {
  'use strict';
  function captionResource(entry) {
    try {
      const url = new URL(entry.name);
      const match = url.pathname.match(/^\/(\d+)\/en(?:[_-][a-z]{2})?\/[^/]+\.vtt$/i);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.udemycdn.com') || !match || !Number.isFinite(entry.startTime)) return null;
      return { url: url.href, asset: match[1], startTime: entry.startTime };
    } catch { return null; }
  }
  function create() {
    let entries = [], floor = 0, source = '', selected = '', waitingFor = null;
    const used = new Set();
    return {
      observe(resources) {
        for (const resource of resources) {
          const entry = captionResource(resource);
          if (!entry || entry.startTime < floor) continue;
          const key = `${entry.startTime}:${entry.url}`;
          if (!entries.some(e => e.key === key)) entries.push({ ...entry, key });
        }
        entries.sort((a, b) => a.startTime - b.startTime);
        entries = entries.slice(-8);
      },
      begin(time, previousSource) {
        floor = time; entries = []; used.clear(); selected = ''; source = '';
        waitingFor = previousSource || null;
      },
      forSource(currentSource) {
        if (!currentSource || currentSource === waitingFor) return '';
        waitingFor = null;
        if (source !== currentSource) { source = currentSource; selected = ''; }
        if (selected) return selected;
        const candidates = entries.filter(e => !used.has(e.key));
        // Ambiguous resources must never put another video's subtitles on screen.
        if (!candidates.length || new Set(candidates.map(e => e.asset)).size !== 1) return '';
        const latest = candidates[candidates.length - 1];
        for (const entry of entries) used.add(entry.key);
        // Both collections remain bounded for long course-preview sessions.
        for (const key of used) if (!entries.some(e => e.key === key)) used.delete(key);
        selected = latest.url;
        return selected;
      }
    };
  }
  const api = { captionResource, create };
  root.PreviewSubtitleSource = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
