const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const id = 'a'.repeat(32);
const srt = '1\n00:00:00,000 --> 00:00:02,500\nHello မြန်မာ\n';
const answer = `BEGIN_${id}\n1\n00:00:00,000 --> 00:00:02,500\nမင်္ဂလာပါ\nEND_${id}`;
const account = { email: 'pro@example.test', index: 0 };
async function setup(t) {
  const { Jobs } = await import('../server/jobs.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'udemy-server-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobs = new Jobs(directory); await jobs.load(); return { jobs, directory, Jobs };
}
test('server stores each full SRT once, rejects mismatched retries and survives restart without resending', async t => {
  const { jobs, Jobs, directory } = await setup(t);
  await jobs.start({ id, srt }); await jobs.start({ id, srt });
  assert.equal(jobs.items.size, 1);
  await assert.rejects(jobs.start({ id, srt: srt.replace('Hello', 'Another') }), /another SRT/);
  await jobs.message(jobs.get(id), { type: 'WEB_SENT', id }, account);
  const restarted = new Jobs(directory); await restarted.load();
  assert.equal(restarted.get(id).state, 'error'); assert.equal(restarted.get(id).srt, '');
});
test('server rejects missing cues and discards late answers after cancellation', async t => {
  const { jobs } = await setup(t); const job = await jobs.start({ id, srt });
  const task = await jobs.message(job, { type: 'WEB_TASK' }, account);
  assert.equal(task.expectedEmail, account.email); assert.equal(task.srt.trim(), srt.trim());
  await jobs.message(job, { type: 'WEB_SENT', id }, account);
  await assert.rejects(jobs.message(job, { type: 'WEB_RESULT', id, raw: answer.replace('\n1\n', '\n2\n') }, account), /cue number/);
  assert.equal(job.state, 'waiting');
  await jobs.cancel(id);
  await jobs.message(job, { type: 'WEB_RESULT', id, raw: answer }, account);
  assert.equal(job.state, 'cancelled'); assert.equal(job.raw, undefined);
});
test('authenticated server HTTP accepts one complete job, returns promptly, then serves only validated output', async t => {
  const { jobs } = await setup(t);
  const { createHttp } = await import('../server/http.mjs');
  let runs = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const token = 't'.repeat(64);
  const server = createHttp({ jobs, token, run: async job => {
    runs++; await jobs.message(job, { type: 'WEB_SENT', id }, account);
    await gate;
    await jobs.message(job, { type: 'WEB_RESULT', id, raw: answer }, account);
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { finish(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/action`;
  const call = async (body, auth = token) => {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call({ action: 'health' }, 'wrong')).status, 401);
  const accepted = await call({ action: 'start', id, srt });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.ok, true); assert.equal(accepted.body.raw, undefined);
  await call({ action: 'start', id, srt });
  assert.equal(runs, 1);
  const pending = await call({ action: 'status', id }); assert.equal(pending.body.state, 'waiting'); assert.equal(pending.body.raw, undefined);
  finish();
  await new Promise(resolve => setTimeout(resolve, 30));
  const completed = await call({ action: 'status', id });
  assert.equal(completed.body.state, 'done'); assert.equal(completed.body.raw, answer);
});

test('server returns canonical original timestamps even when Gemini changes them', async t => {
 const {jobs} = await setup(t); const job = await jobs.start({id, srt});
 await jobs.message(job, {type:'WEB_SENT',id},account);
 await jobs.message(job, {type:'WEB_RESULT',id,raw:answer.replace('02,500','03,000')},account);
 assert.equal(job.state,'done'); assert.equal(job.raw, answer);
});
