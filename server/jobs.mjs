import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.SubtitleCore = require('../core.js');
export const subtitle = require('../browser-core.js');
const terminal = job => ['done', 'error', 'cancelled'].includes(job.state);
export class Jobs {
  constructor(directory) { this.directory = directory; this.items = new Map(); this.writes = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let saved;
    try { saved = JSON.parse(await readFile(join(this.directory, 'jobs.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; saved = []; }
    for (const job of saved) {
      if (!terminal(job)) { job.state = 'error'; job.error = 'The browser worker restarted. Retry from Udemy; the file was not automatically resent.'; job.srt = ''; job.cues = []; }
      if (Date.now() - job.created < 86400000) this.items.set(job.id, job);
    }
    await this.save();
  }
  save() {
    const data = JSON.stringify([...this.items.values()]);
    this.writes = this.writes.then(async () => {
      const temporary = join(this.directory, 'jobs.tmp');
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, join(this.directory, 'jobs.json'));
    });
    return this.writes;
  }
  async start(input) {
    if (!/^[a-f0-9]{32}$/.test(input.id || '') || typeof input.srt !== 'string' || input.srt.length > 2000000) throw new Error('Invalid SRT job.');
    const cues = globalThis.SubtitleCore.parseSubtitles(input.srt);
    if (!cues.length) throw new Error('The full SRT must contain timestamped cues.');
    const srt = subtitle.toSrt(cues);
    const browserModel = subtitle.model(input.browserModel);
    const hash = createHash('sha256').update(JSON.stringify([srt, browserModel])).digest('hex');
    this.prune();
    const old = this.items.get(input.id);
    if (old) { if (old.hash !== hash) throw new Error('This job ID is already associated with another SRT.'); return old; }
    if ([...this.items.values()].filter(job => !terminal(job)).length >= 20) throw new Error('The browser queue is full. Try later.');
    const job = { id: input.id, hash, srt, cues, browserModel, state: 'ready', created: Date.now(), status: 'Queued for server Gemini / selected model.' };
    this.items.set(job.id, job); await this.save(); return job;
  }
  prune() { for (const [id, job] of this.items) if (terminal(job) && Date.now() - job.created > 86400000) this.items.delete(id); }
  async cancel(id) {
    const job = this.get(id);
    if (!terminal(job)) { job.state = 'cancelled'; job.srt = ''; job.cues = []; await this.save(); }
    return job;
  }
  get(id) { this.prune(); const job = this.items.get(id); if (!job) throw new Error('Subtitle job not found or expired.'); return job; }
  public(job) { return { ok: true, id: job.id, state: job.state, status: job.status, error: job.error, ...(job.state === 'done' ? { raw: job.raw } : {}) }; }
  async message(job, input, account) {
    if (input.type === 'WEB_TASK') return { ok: true, id: job.id, state: job.state, expectedEmail: account.email, accountIndex: account.index, browserModel: job.browserModel || 'argon-medium', srt: job.state === 'ready' ? job.srt : undefined, prompt: job.state === 'ready' ? subtitle.prompt(job.id, job.cues.length) : undefined, error: job.error };
    if (input.id !== job.id) return { ok: false, error: 'Stale subtitle response.' };
    if (input.type === 'WEB_SENT' && job.state === 'ready') { job.state = 'waiting'; job.status = 'The full SRT is being translated in server Gemini / selected model.'; await this.save(); return { ok: true, claimed: true }; }
    if (input.type === 'WEB_RESULT' && job.state === 'waiting') {
      if (typeof input.raw !== 'string' || input.raw.length > 4000000) throw new Error('Invalid Gemini response.');
      const translated = subtitle.translatedCues(input.raw, job.id, job.cues);
      job.raw = `BEGIN_${job.id}\n${subtitle.toSrt(translated)}END_${job.id}`;
      job.state = 'done'; job.status = 'Complete translated SRT validated with original timestamps.'; job.srt = ''; job.cues = []; await this.save();
    }
    if (input.type === 'WEB_ERROR' && !terminal(job)) await this.fail(job, input.error);
    return { ok: true };
  }
  async fail(job, message) {
    if (terminal(job)) return;
    job.state = 'error'; job.error = String(message || 'Server browser translation failed.').slice(0, 300); job.srt = ''; job.cues = []; await this.save();
  }
}
