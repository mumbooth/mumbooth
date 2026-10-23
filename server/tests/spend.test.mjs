import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, buyCoupons, chatBody, parseSse, scriptedModel } from './helpers.mjs';

const spentCount = (s) => s.db.get('SELECT COUNT(*) AS n FROM spent').n;
const counter = (s) => s.db.get("SELECT v FROM counters WHERE k='spent_total'").v;

test('valid coupon streams meta/delta/done, spent row written; same coupon again -> 409 coupon_spent', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  const [c] = await buyCoupons(s, 1);
  const r = await s.call('POST', '/api/chat', { body: chatBody([c]) });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/event-stream/);
  assert.equal(r.headers['x-accel-buffering'], 'no');
  const ev = parseSse(r.text);
  assert.deepEqual(ev.map((e) => e.event), ['meta', 'delta', 'delta', 'done']);
  assert.deepEqual(ev[0].data, { model: 'claude-haiku-5-5', couponsSpent: 1 });
  assert.equal(ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), 'Hello world');
  assert.equal(spentCount(s), 1); assert.equal(counter(s), 1);
  const again = await s.call('POST', '/api/chat', { body: chatBody([c]) });
  assert.equal(again.status, 409); assert.deepEqual([again.body.error, again.body.index], ['coupon_spent', 0]);
});

test('two PARALLEL requests with the same coupon: exactly one succeeds', async (t) => {
  let release; const gate = new Promise((r) => { release = r; });
  const s = await setup({ model: scriptedModel({ gate }) }); t.after(() => s.close());
  const [c] = await buyCoupons(s, 1);
  const p1 = s.call('POST', '/api/chat', { body: chatBody([c]) });
  const p2 = s.call('POST', '/api/chat', { body: chatBody([c]) });
  await new Promise((r) => setTimeout(r, 50));
  release();
  const rs = await Promise.all([p1, p2]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal(spentCount(s), 1);
});

test('same coupon twice inside one request -> coupon_spent on the second index, nothing reserved', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  const [c, d, e] = await buyCoupons(s, 3);
  const r = await s.call('POST', '/api/chat', { body: chatBody([c, c, d], { model: 'deep' }) });
  assert.equal(r.status, 409); assert.equal(r.body.index, 1);
  assert.equal(spentCount(s), 0);
  assert.ok(e);
});

test('deep reserves 3 atomically; 2 coupons -> 402 coupons_required with no spent rows', async (t) => {
  const calls = [];
  const s = await setup({ model: scriptedModel({ calls }) }); t.after(() => s.close());
  const cs = await buyCoupons(s, 3);
  let r = await s.call('POST', '/api/chat', { body: chatBody(cs.slice(0, 2), { model: 'deep' }) });
  assert.equal(r.status, 402); assert.deepEqual([r.body.error, r.body.need, r.body.got], ['coupons_required', 3, 2]);
  assert.equal(spentCount(s), 0);
  r = await s.call('POST', '/api/chat', { body: chatBody(cs, { model: 'deep' }) });
  assert.equal(r.status, 200);
  assert.equal(parseSse(r.text)[0].data.couponsSpent, 3);
  assert.equal(parseSse(r.text)[0].data.model, 'claude-sonnet-5-5');
  assert.equal(spentCount(s), 3);
  assert.equal(calls[0].maxTokens, 2048);
});

test('a spent coupon inside a deep bundle rolls the whole reservation back', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  const cs = await buyCoupons(s, 4);
  assert.equal((await s.call('POST', '/api/chat', { body: chatBody([cs[1]]) })).status, 200);
  const r = await s.call('POST', '/api/chat', { body: chatBody([cs[0], cs[1], cs[2]], { model: 'deep' }) });
  assert.equal(r.status, 409); assert.equal(r.body.index, 1);
  assert.equal(spentCount(s), 1);
  assert.equal((await s.call('POST', '/api/chat', { body: chatBody([cs[0], cs[2], cs[3]], { model: 'deep' }) })).status, 200);
});

test('model fails BEFORE the first token -> 503 and the spent row is deleted (coupon reusable)', async (t) => {
  const model = scriptedModel({ fail: 'before' });
  const s = await setup({ model }); t.after(() => s.close());
  const [c] = await buyCoupons(s, 1);
  const r = await s.call('POST', '/api/chat', { body: chatBody([c]) });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'model_unavailable');
  assert.equal(spentCount(s), 0); assert.equal(counter(s), 0);
  s.ctx.model = scriptedModel();
  assert.equal((await s.call('POST', '/api/chat', { body: chatBody([c]) })).status, 200);
});

test('model fails AFTER the first token -> error {spent:true} event and the row stays', async (t) => {
  const s = await setup({ model: scriptedModel({ fail: 'after' }) }); t.after(() => s.close());
  const [c] = await buyCoupons(s, 1);
  const r = await s.call('POST', '/api/chat', { body: chatBody([c]) });
  assert.equal(r.status, 200);
  const ev = parseSse(r.text);
  assert.deepEqual(ev.map((e) => e.event), ['meta', 'delta', 'error']);
  assert.deepEqual(ev[2].data, { code: 'model_error', spent: true });
  assert.equal(spentCount(s), 1);
});

test('empty model output counts as failure before first token (refund)', async (t) => {
  const s = await setup({ model: scriptedModel({ chunks: [] }) }); t.after(() => s.close());
  const [c] = await buyCoupons(s, 1);
  assert.equal((await s.call('POST', '/api/chat', { body: chatBody([c]) })).status, 503);
  assert.equal(spentCount(s), 0);
});

test('circuit breaker: 5 consecutive failures -> 60 s of 503 without touching coupons or the model', async (t) => {
  const calls = [];
  const s = await setup({ model: scriptedModel({ fail: 'before', calls }) }); t.after(() => s.close());
  const [c] = await buyCoupons(s, 1);
  for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/chat', { body: chatBody([c]) })).status, 503);
  assert.equal(calls.length, 5);
  const r = await s.call('POST', '/api/chat', { body: chatBody([c]) });
  assert.equal(r.status, 503); assert.equal(calls.length, 5, 'model not called while open');
  s.clock.t += 61_000;
  s.ctx.model = scriptedModel();
  assert.equal((await s.call('POST', '/api/chat', { body: chatBody([c]) })).status, 200);
});

test('expired epoch -> 410 key_expired; unknown epoch / forged / malformed -> 401 coupon_invalid {index}', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  const [c, d] = await buyCoupons(s, 2);
  let r = await s.call('POST', '/api/chat', { body: chatBody([{ ...c, epoch: 'k9' }]) });
  assert.deepEqual([r.status, r.body.error, r.body.index], [401, 'coupon_invalid', 0]);
  const forged = { ...c, msg: Buffer.alloc(32, 7).toString('base64') };
  r = await s.call('POST', '/api/chat', { body: chatBody([forged]) });
  assert.equal(r.status, 401);
  r = await s.call('POST', '/api/chat', { body: chatBody([{ epoch: 'k1', msg: 'x', sig: 'y' }]) });
  assert.equal(r.status, 401);
  assert.equal(spentCount(s), 0);
  s.clock.t += 61 * 86400_000;
  r = await s.call('POST', '/api/chat', { body: chatBody([d]) });
  assert.equal(r.status, 410); assert.equal(r.body.error, 'key_expired');
  assert.equal(spentCount(s), 0);
});

test('request validation: roles, size, mode, context_too_long {maxChars}', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  const [c] = await buyCoupons(s, 1);
  const post = (extra) => s.call('POST', '/api/chat', { body: chatBody([c], extra) });
  assert.equal((await post({ messages: [{ role: 'assistant', content: 'x' }] })).body.error, 'bad_request');
  assert.equal((await post({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] })).body.error, 'bad_request');
  assert.equal((await post({ mode: 'nope' })).body.error, 'bad_request');
  assert.equal((await post({ model: 'huge' })).body.error, 'bad_request');
  let r = await post({ messages: [{ role: 'user', content: 'x'.repeat(8001) }] });
  assert.deepEqual([r.status, r.body.error, r.body.maxChars], [400, 'context_too_long', 8000]);
  const many = []; for (let i = 0; i < 7; i++) { many.push({ role: 'user', content: 'y'.repeat(4000) }, { role: 'assistant', content: 'z'.repeat(4000) }); } many.push({ role: 'user', content: 'q' });
  r = await post({ messages: many.slice(0, 7) });
  assert.deepEqual([r.status, r.body.error, r.body.maxChars], [400, 'context_too_long', 24000]);
  assert.equal(spentCount(s), 0);
  assert.equal((await post({})).status, 200);
});

test('spent table schema: only hash + epoch (no time / ip / model / length)', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const cols = s.db.all('PRAGMA table_info(spent)').map((c) => c.name).sort();
  assert.deepEqual(cols, ['epoch', 'hash']);
  assert.equal(s.db.all("SELECT name FROM sqlite_master WHERE type='table'").some((r) => r.name === 'trial'), false);
});

test('model call gets the system prompt, no coupons or ip in its arguments', async (t) => {
  const calls = [];
  const s = await setup({ model: scriptedModel({ calls }) }); t.after(() => s.close());
  const [c] = await buyCoupons(s, 1);
  await s.call('POST', '/api/chat', { body: chatBody([c]), remoteAddress: '203.0.113.9' });
  const a = JSON.stringify({ ...calls[0], signal: undefined });
  assert.ok(!a.includes('203.0.113.9') && !a.includes(c.sig) && !a.includes(c.msg));
  assert.ok(calls[0].system.length > 20);
});
