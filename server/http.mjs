import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
export function createHttp({ jobs, token, run }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('RUNNER_TOKEN must be at least 32 characters.');
  let active = false;
  async function pump() {
    if (active) return;
    active = true;
    try {
      for (;;) {
        const job = [...jobs.items.values()].find(item => item.state === 'ready');
        if (!job) break;
        try { await run(job); } catch { await jobs.fail(job, 'The server browser could not complete this job. Open the login desktop and retry.'); }
        if (['ready', 'waiting'].includes(job.state)) await jobs.fail(job, 'The server browser stopped without a complete translated SRT.');
      }
    } finally { active = false; }
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    const reply = (status, data) => { response.writeHead(status); response.end(JSON.stringify(data)); };
    const supplied = String(request.headers.authorization || '');
    const expected = 'Bearer ' + token;
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { request.resume(); reply(401, { ok: false, error: 'Unauthorized browser worker request.' }); return; }
    if (request.method !== 'POST' || request.url !== '/action') { request.resume(); reply(404, { ok: false, error: 'Not found.' }); return; }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 8500000) throw new Error('Request is too large.'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (input.action === 'health') { reply(200, { ok: true, state: 'ready', model: 'Argon Medium' }); return; }
      if (!/^[a-f0-9]{32}$/.test(input.id || '')) throw new Error('Invalid subtitle job ID.');
      let job;
      if (input.action === 'start') job = await jobs.start(input);
      else if (input.action === 'cancel') job = await jobs.cancel(input.id);
      else if (input.action === 'status') job = jobs.get(input.id);
      else throw new Error('Unknown subtitle action.');
      reply(200, jobs.public(job));
      if (input.action === 'start') setImmediate(() => pump().catch(() => {}));
    } catch (error) { reply(400, { ok: false, error: error instanceof SyntaxError ? 'Invalid JSON request.' : error.message }); }
  });
  server.requestTimeout = 25000;
  return server;
}
