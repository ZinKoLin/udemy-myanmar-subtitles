function n8nConnection(settings) {
  let url; try { url = new URL(settings.n8nUrl); } catch { throw new Error('Configure the n8n webhook URL in extension settings.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.hash || url.search) throw new Error('Invalid n8n webhook URL. Use HTTPS or a localhost SSH tunnel.');
  if (typeof settings.n8nToken !== 'string' || settings.n8nToken.length < 32 || /[\r\n]/.test(settings.n8nToken)) throw new Error('Configure the n8n webhook access token in extension settings.');
  return { url: url.href, token: settings.n8nToken, origin: url.origin };
}
async function n8nRequest(connection, data) {
  if (!await chrome.permissions.contains({ origins: [connection.origin + '/*'] })) throw new Error('Save the n8n connection in the extension popup to grant access to its host.');
  let response;
  try {
    response = await fetch(connection.url, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Udemy-Token': connection.token }, body: JSON.stringify(data), signal: AbortSignal.timeout(20000) });
  } catch { throw new Error('Could not reach n8n. Check your server and webhook URL. No local Gemini fallback was used.'); }
  if (!response.ok) throw new Error(`n8n returned HTTP ${response.status}. Check the production webhook and its access token.`);
  const raw = await response.text();
  if (raw.length > 4500000) throw new Error('The n8n response is too large.');
  let result; try { result = JSON.parse(raw); } catch { throw new Error('n8n did not return a JSON job response. Check the workflow.'); }
  if (!result || result.ok !== true) throw new Error(typeof result?.error === 'string' ? result.error.slice(0, 300) : 'The n8n browser worker rejected the request.');
  if (data.id && result.id !== data.id) throw new Error('n8n returned a result for a different subtitle job.');
  return result;
}
