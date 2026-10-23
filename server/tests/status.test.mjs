import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, wallet, buyCoupons, chatBody, scriptedModel, TOKEN, DEAD, MOCK_TREASURY } from './helpers.mjs';

test('status: DB numbers are right, chain numbers come from the chain, shape matches BRIEF', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  const cs = await buyCoupons(s, 5);
  await buyCoupons(s, 2);
  await s.call('POST', '/api/chat', { body: chatBody([cs[0]]) });
  await s.call('POST', '/api/chat', { body: chatBody([cs[1]]) });
  const r = await s.call('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'public, max-age=15');
  const b = r.body;
  assert.deepEqual([b.issued, b.spent, b.purchases], [7, 2, 2]);
  assert.deepEqual(b.issuedByKey, { k1: 7 });
  assert.equal(b.ethReceivedWei, (7n * 20_000_000_000_000n).toString());
  assert.equal(b.rpc, 'ok');
  assert.equal(b.burnedWei, null);
  assert.deepEqual([b.chainId, b.treasury, b.priceWei, b.maxPack, b.holdPerDay, b.keyId], [4663, MOCK_TREASURY, '20000000000000', 500, 5, 'k1']);
  assert.deepEqual(b.token, { address: null, symbol: null, tokensPerCoupon: null, holdMin: null });
  assert.deepEqual(b.trial, { perDay: 3 });
  assert.deepEqual(b.models, { fast: { coupons: 1 }, deep: { coupons: 3 } });
  assert.ok(b.explorer.startsWith('https://'));
});

test('status: RPC down -> 200 with ethReceivedWei null and rpc "down"; DB numbers stay', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  await buyCoupons(s, 3);
  s.rpc.setDown(true);
  const r = await s.call('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ethReceivedWei, r.body.rpc, r.body.issued, r.body.purchases], [null, 'down', 3, 1]);
});

test('status: after the CA, token fields + burnedWei appear', async (t) => {
  const s = await setup({ env: { TOKENS_PER_COUPON: '1000', HOLD_MIN: '1000000' }, token: TOKEN }); t.after(() => s.close());
  s.rpc.setTokenBalance(TOKEN, DEAD, 12345n);
  const r = await s.call('GET', '/api/status');
  assert.deepEqual(r.body.token, { address: TOKEN, symbol: 'MUM', tokensPerCoupon: '1000', holdMin: '1000000' });
  assert.equal(r.body.burnedWei, '12345');
});

test('status: chain reads are memoised for statusTtlMs', async (t) => {
  const s = await setup(); t.after(() => s.close());
  s.config.statusTtlMs = 15_000;
  let n = 0; const orig = s.rpc.getBalance; s.rpc.getBalance = async (a) => { n++; return orig(a); };
  await s.call('GET', '/api/status'); await s.call('GET', '/api/status');
  assert.equal(n, 1);
  s.clock.t += 16_000;
  await s.call('GET', '/api/status');
  assert.equal(n, 2);
});

test('proof: last purchases (eth/burn only), counts, hold claims', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  const w = wallet();
  await buyCoupons(s, 2, w); s.clock.t += 1000; await buyCoupons(s, 4);
  const r = await s.call('GET', '/api/proof');
  assert.equal(r.status, 200);
  assert.equal(r.body.purchases.length, 2);
  assert.deepEqual(r.body.purchases.map((p) => [p.kind, p.n]), [['eth', 4], ['eth', 2]]);
  assert.match(r.body.purchases[0].txHash, /^0xmock4c/);
  assert.deepEqual(r.body.holdClaims, { today: 0, total: 0 });
  assert.deepEqual([r.body.issued, r.body.spent], [6, 0]);
});

test('GET /healthz and unknown routes', async (t) => {
  const s = await setup(); t.after(() => s.close());
  assert.deepEqual((await s.call('GET', '/healthz')).body, { ok: true });
  assert.equal((await s.call('GET', '/api/nope')).status, 404);
});

test('expired-epoch spent rows are swept, counter keeps the total', async (t) => {
  const s = await setup({ model: scriptedModel() }); t.after(() => s.close());
  const [c] = await buyCoupons(s, 1);
  await s.call('POST', '/api/chat', { body: chatBody([c]) });
  const { sweepSpent } = await import('../stats.mjs');
  sweepSpent(s.ctx);
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM spent').n, 1);
  s.clock.t += 61 * 86400_000;
  sweepSpent(s.ctx);
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM spent').n, 0);
  assert.equal(s.db.get("SELECT v FROM counters WHERE k='spent_total'").v, 1);
});
