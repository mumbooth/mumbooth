import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, wallet, blindMany, holdBody, finalize, TOKEN } from './helpers.mjs';

const E18 = 10n ** 18n;
const DAY = '2026-10-24';
const env = { TOKENS_PER_COUPON: '1000', HOLD_MIN: '1000000', HOLD_PER_DAY: '5' };

test('before the CA exists -> 409 not_launched', async (t) => {
  const s = await setup({ env }); t.after(() => s.close());
  const w = wallet();
  const r = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, DAY, await blindMany(s, 5)) });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'not_launched');
});

test('balance below minimum -> 403 below_minimum {holdMin, balance}; at the minimum -> 5 valid coupons', async (t) => {
  const s = await setup({ env, token: TOKEN }); t.after(() => s.close());
  const w = wallet();
  s.rpc.setTokenBalance(TOKEN, w.address, 999_999n * E18);
  let items = await blindMany(s, 5);
  let r = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, DAY, items) });
  assert.equal(r.status, 403); assert.deepEqual([r.body.error, r.body.holdMin, r.body.balance], ['below_minimum', '1000000', '999999']);
  s.rpc.setTokenBalance(TOKEN, w.address, 1_000_000n * E18);
  r = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, DAY, items) });
  assert.equal(r.status, 200); assert.equal(r.body.n, 5);
  assert.equal((await finalize(s, items, r.body)).length, 5);
  assert.equal(s.db.get("SELECT kind FROM issued WHERE tx_hash LIKE 'hold:%'").kind, 'hold');
});

test('second claim the same day with a different batch -> 409 already_claimed {nextAt}; same batch is idempotent', async (t) => {
  const s = await setup({ env, token: TOKEN }); t.after(() => s.close());
  const w = wallet();
  s.rpc.setTokenBalance(TOKEN, w.address, 5_000_000n * E18);
  const items = await blindMany(s, 5);
  const r1 = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, DAY, items) });
  const r1b = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, DAY, items) });
  assert.deepEqual(r1b.body, r1.body);
  const r2 = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, DAY, await blindMany(s, 5)) });
  assert.equal(r2.status, 409); assert.equal(r2.body.error, 'already_claimed'); assert.equal(r2.body.nextAt, '2026-10-25T00:00:00.000Z');
  s.clock.t += 24 * 3600_000;
  const r3 = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, '2026-10-25', await blindMany(s, 5)) });
  assert.equal(r3.status, 200);
});

test('wrong day -> 400 bad_day; too many -> too_many_coupons {allowed}; bad sig -> 401; rpc down -> 503', async (t) => {
  const s = await setup({ env, token: TOKEN }); t.after(() => s.close());
  const w = wallet();
  s.rpc.setTokenBalance(TOKEN, w.address, 5_000_000n * E18);
  let r = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, '2026-10-23', await blindMany(s, 1)) });
  assert.deepEqual([r.status, r.body.error], [400, 'bad_day']);
  r = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, DAY, await blindMany(s, 6)) });
  assert.deepEqual([r.status, r.body.error, r.body.allowed], [400, 'too_many_coupons', 5]);
  const b = await holdBody(w, DAY, await blindMany(s, 1));
  r = await s.call('POST', '/api/hold/claim', { body: { ...b, address: wallet().address } });
  assert.equal(r.status, 401);
  s.rpc.setDown(true);
  r = await s.call('POST', '/api/hold/claim', { body: await holdBody(w, DAY, await blindMany(s, 1)) });
  assert.equal(r.status, 503);
});
