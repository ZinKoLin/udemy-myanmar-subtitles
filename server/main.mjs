import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Jobs } from './jobs.mjs';
import { createHttp } from './http.mjs';
const email = process.env.GEMINI_ACCOUNT_EMAIL?.trim().toLowerCase();
const index = Number(process.env.GEMINI_ACCOUNT_INDEX || '0');
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Number.isInteger(index) || index < 0 || index > 20) throw new Error('Configure GEMINI_ACCOUNT_EMAIL and GEMINI_ACCOUNT_INDEX first.');
const jobs = new Jobs(process.env.JOBS_DIR || '/data/jobs'); await jobs.load();
setInterval(() => {
  const count = jobs.items.size; jobs.prune();
  if (jobs.items.size !== count) jobs.save().catch(() => console.error('Could not prune expired subtitle jobs.'));
}, 60000).unref();
const context = await chromium.launchPersistentContext(process.env.PROFILE_DIR || '/data/profile', {
  headless: false, chromiumSandbox: true, viewport: { width: 1280, height: 800 },
  args: ['--disable-dev-shm-usage']
});
const accountUrl = `https://gemini.google.com/u/${index}/app`;
const login = context.pages()[0] || await context.newPage();
await login.goto(accountUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
const adapter = await readFile(fileURLToPath(new URL('../gemini-browser.js', import.meta.url)), 'utf8');
async function run(job) {
  const page = await context.newPage();
  try {
    await page.exposeBinding('__udemySubtitleTransport', async ({ page: source }, message) => {
      if (new URL(source.url()).origin !== 'https://gemini.google.com') return { ok: true, idle: true };
      try { return await jobs.message(job, message, { email, index }); }
      catch (error) { await jobs.fail(job, error.message); return { ok: false, error: error.message }; }
    });
    await page.addInitScript({ content: adapter });
    await page.goto(accountUrl + '#udemy-srt=' + job.id, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + 20 * 60 * 1000;
    while (['ready', 'waiting'].includes(job.state) && !page.isClosed()) {
      if (Date.now() > deadline) { await jobs.fail(job, 'Server Gemini timed out after 20 minutes. Check login or account limits, then retry.'); break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { await page.close().catch(() => {}); }
}
const server = createHttp({ jobs, token: process.env.RUNNER_TOKEN, run });
server.listen(3000, '0.0.0.0', () => console.log('Udemy browser worker ready on private port 3000. Sign in through the SSH-tunneled desktop.'));
async function shutdown() { server.close(); await context.close(); await jobs.writes; process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
