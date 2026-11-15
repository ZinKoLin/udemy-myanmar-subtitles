(function (root) {
  'use strict';
  function subtitleUrl(tracks, pageUrl) {
    try {
      const page = new URL(pageUrl);
      if (page.protocol !== 'https:' || !['coursera.org', 'www.coursera.org'].includes(page.hostname) || page.port) return '';
      for (const track of tracks) {
        if (!/^en(?:[_-]|$)/i.test(track.srclang || '') && !/^English(?:\s|$)/i.test(track.label || '')) continue;
        const url = new URL(track.src, page);
        if (url.origin !== page.origin || url.username || url.password || url.hash || !/^\/api\/subtitleAssetProxy\.v1\/[\w-]{1,128}$/.test(url.pathname) || !['vtt', 'srt'].includes(url.searchParams.get('fileExtension'))) continue;
        return url.href;
      }
    } catch { /* Malformed page/track URLs are never fetched. */ }
    return '';
  }
  const api = { subtitleUrl };
  root.CourseraSubtitleSource = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
