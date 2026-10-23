import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, scriptedModel, parseSse } from './helpers.mjs';

const trialBody = (extra = {}) => ({ mode: 'trial', model: 'deep', messages: [{ role: 'user', content: 'hello' }], ...extra });
const post = (s, ip = '198.51.100.1', extra) => s.call('POST', '/api/chat', { body: trialBody(extra), remoteAddress: ip });

test('3 OK then 429 trial_exhausted {resetAt}; another IP is unaffected; model forced to fast with 512 tokens', async (t) => {
  const calls = [];
  const s = await setup({ model: scriptedModel({ calls }) }); t.after(() => s.close());
  for (let i = 0; i < 3; i++) {
    const r = await post(s);
    assert.equal(r.status, 200);
    assert.deepEqual(parseSse(r.text)[0].data, { model: 'claude-haiku-5-5', couponsSpent: 0 });
  }
  assert.ok(calls.every((c) => c.model === 'claude-haiku-5-5' && c.maxTokens === 512));
  const r = await post(s);
  assert.equal(r.status, 429); assert.equal(r.body.error, 'trial_exhausted');
  assert.equal(r.body.resetAt, '2026-10-25T00:00:00.000Z');
  assert.equal((await post(s, '198.51.100.2')).status, 200);
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM spent').n, 0, 'trial never touches coupons');
});

test('new UTC day resets the counters and draws a new salt', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  for (let i = 0; i < 3; i++) await post(s);
  const before = s.ctx.trial._stats();
  s.clock.t += 24 * 3600_000;
  assert.equal((await post(s)).status, 200);
  const after = s.ctx.trial._stats();
  assert.notEqual(after.salt, before.salt);
  assert.equal(after.keys, 1); assert.equal(after.total, 1);
});

test('global TRIAL_DAILY_CAP -> 429 trial_paused', async (t) => {
  const s = await setup({ model: scriptedModel(), env: { TRIAL_DAILY_CAP: '2' } }); t.after(() => s.close());
  assert.equal((await post(s, '198.51.100.1')).status, 200);
  assert.equal((await post(s, '198.51.100.2')).status, 200);
  const r = await post(s, '198.51.100.3');
  assert.equal(r.status, 429); assert.equal(r.body.error, 'trial_paused');
});

test('trial limits: > 6 messages or > 6000 chars -> context_too_long; model failure before first token refunds the trial message', async (t) => {
  const s = await setup({ model: scriptedModel({ fail: 'before' }) }); t.after(() => s.close());
  const longMsgs = [{ role: 'user', content: 'x'.repeat(6001) }];
  let r = await post(s, '198.51.100.1', { messages: longMsgs });
  assert.deepEqual([r.status, r.body.error, r.body.maxChars], [400, 'context_too_long', 6000]);
  const seven = []; for (let i = 0; i < 7; i++) seven.push({ role: i % 2 ? 'assistant' : 'user', content: 'a' });
  r = await post(s, '198.51.100.1', { messages: seven });
  assert.equal(r.body.error, 'context_too_long');
  for (let i = 0; i < 4; i++) assert.equal((await post(s)).status, 503, 'never 429: every failed attempt was refunded');
  assert.equal(s.ctx.trial._stats().total, 0, 'failed attempts were refunded');
});
