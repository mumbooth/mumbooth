import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, wallet, blindMany, issueBody, finalize, TOKEN, DEAD, MOCK_TREASURY } from './helpers.mjs';
import { verifyCoupon } from '../blind.mjs';

const H = (n) => '0x' + n.toString(16).padStart(64, '0');
const PRICE = 20_000_000_000_000n;

async function ethTx(s, hash, from, value, to = MOCK_TREASURY, input = '0x') { s.rpc.addTx(hash, { from, to, value, input }); }

test('valid ETH tx -> N coupons that finalize and verify; row stored', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const w = wallet(), hash = H(1), items = await blindMany(s, 5);
  await ethTx(s, hash, w.address, PRICE * 5n);
  const r = await s.call('POST', '/api/issue', { body: await issueBody(w, hash, items) });
  assert.equal(r.status, 200);
  assert.equal(r.body.keyId, 'k1'); assert.equal(r.body.n, 5); assert.equal(r.body.blindSigs.length, 5);
  const coupons = await finalize(s, items, r.body);
  const k = s.keys.currentKey();
  for (const c of coupons) assert.equal(await verifyCoupon(k.publicKey, Buffer.from(c.msg, 'base64'), Buffer.from(c.sig, 'base64')), true);
  const row = s.db.get('SELECT * FROM issued WHERE tx_hash = ?', hash);
  assert.equal(row.n, 5); assert.equal(row.kind, 'eth'); assert.equal(row.address, w.address.toLowerCase());
});

test('overpay rounds down: asking for floor(value/price) works, one more is underpaid', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const w = wallet(), hash = H(2);
  await ethTx(s, hash, w.address, PRICE * 3n + PRICE / 2n);
  let r = await s.call('POST', '/api/issue', { body: await issueBody(w, hash, await blindMany(s, 4)) });
  assert.equal(r.status, 402); assert.equal(r.body.error, 'underpaid'); assert.equal(r.body.priceWei, PRICE.toString());
  r = await s.call('POST', '/api/issue', { body: await issueBody(w, hash, await blindMany(s, 3)) });
  assert.equal(r.status, 200);
});

test('too_many_coupons {allowed}', async (t) => {
  const s = await setup({ env: { MAX_PACK: '3' } }); t.after(() => s.close());
  const w = wallet(), hash = H(3);
  await ethTx(s, hash, w.address, PRICE * 10n);
  const r = await s.call('POST', '/api/issue', { body: await issueBody(w, hash, await blindMany(s, 4)) });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'too_many_coupons'); assert.equal(r.body.allowed, 3);
});

test('wrong_recipient, unsupported_tx, tx_failed, tx_not_found', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const w = wallet();
  const go = async (hash) => s.call('POST', '/api/issue', { body: await issueBody(w, hash, await blindMany(s, 1)) });
  await ethTx(s, H(10), w.address, PRICE, '0x3333333333333333333333333333333333333333');
  assert.deepEqual([(await go(H(10))).status, (await go(H(10))).body.error], [400, 'wrong_recipient']);
  await ethTx(s, H(11), w.address, PRICE, MOCK_TREASURY, '0xdeadbeef');
  assert.equal((await go(H(11))).body.error, 'unsupported_tx');
  s.rpc.addTx(H(12), { from: w.address, to: MOCK_TREASURY, value: PRICE }, { status: 'reverted' });
  assert.equal((await go(H(12))).body.error, 'tx_failed');
  const nf = await go(H(13));
  assert.equal(nf.status, 404); assert.equal(nf.body.error, 'tx_not_found');
});

test('bad_signature (garbage + wrong key) and signer_mismatch (valid sig, not the sender)', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const a = wallet(), b = wallet(), hash = H(20), items = await blindMany(s, 1);
  await ethTx(s, hash, a.address, PRICE);
  const body = await issueBody(a, hash, items);
  let r = await s.call('POST', '/api/issue', { body: { ...body, sig: '0x' + '11'.repeat(65) } });
  assert.equal(r.status, 401); assert.equal(r.body.error, 'bad_signature');
  const forged = await issueBody(b, hash, items); // b signs a correct message but claims to be a
  r = await s.call('POST', '/api/issue', { body: { ...forged, address: a.address } });
  assert.equal(r.status, 401);
  r = await s.call('POST', '/api/issue', { body: forged }); // b is honest about being b, but a sent the tx
  assert.equal(r.status, 403); assert.equal(r.body.error, 'signer_mismatch');
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM issued').n, 0);
});

test('tx_used for a different batch; same batch is idempotent with identical blindSigs; other wallet cannot replay', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const w = wallet(), hash = H(30), items = await blindMany(s, 2);
  await ethTx(s, hash, w.address, PRICE * 5n);
  const body = await issueBody(w, hash, items);
  const r1 = await s.call('POST', '/api/issue', { body });
  const r2 = await s.call('POST', '/api/issue', { body });
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, r1.body);
  const r3 = await s.call('POST', '/api/issue', { body: await issueBody(w, hash, await blindMany(s, 2)) });
  assert.equal(r3.status, 409); assert.equal(r3.body.error, 'tx_used');
  const r4 = await s.call('POST', '/api/issue', { body: await issueBody(wallet(), hash, items) });
  assert.equal(r4.status, 403);
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM issued').n, 1);
});

test('idempotent retry still works after the chain/RPC is down (row is local)', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const w = wallet(), hash = H(31), items = await blindMany(s, 1);
  await ethTx(s, hash, w.address, PRICE);
  const body = await issueBody(w, hash, items);
  assert.equal((await s.call('POST', '/api/issue', { body })).status, 200);
  s.rpc.setDown(true);
  assert.equal((await s.call('POST', '/api/issue', { body })).status, 200);
});

test('rpc down -> 503 rpc_unavailable', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const w = wallet();
  s.rpc.setDown(true);
  const r = await s.call('POST', '/api/issue', { body: await issueBody(w, H(40), await blindMany(s, 1)) });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'rpc_unavailable');
});

test('bad_request on malformed input', async (t) => {
  const s = await setup(); t.after(() => s.close());
  for (const body of [{}, { address: 'x' }, { address: wallet().address, txHash: H(1), blinded: ['AAAA'], sig: '0x' + '11'.repeat(65) }, null]) {
    const r = await s.call('POST', '/api/issue', { body });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.error, 'bad_request');
  }
});

test('burn before CA -> 409 not_launched', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const w = wallet(), hash = H(50);
  s.rpc.addTx(hash, { from: w.address, to: TOKEN, value: 0, input: '0xa9059cbb' + '00'.repeat(64) }, { logs: [{ token: TOKEN, from: w.address, to: DEAD, value: 10n ** 24n }] });
  const r = await s.call('POST', '/api/issue', { body: await issueBody(w, hash, await blindMany(s, 1)) });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'not_launched');
});

test('burn after CA: N = floor(amount / TOKENS_PER_COUPON); non-dead transfer is unsupported', async (t) => {
  const s = await setup({ env: { TOKENS_PER_COUPON: '1000' }, token: TOKEN }); t.after(() => s.close());
  const w = wallet(), E18 = 10n ** 18n;
  const mk = (hash, amount, to = DEAD) => s.rpc.addTx(hash, { from: w.address, to: TOKEN, value: 0, input: '0xa9059cbb' + '00'.repeat(64) }, { logs: [{ token: TOKEN, from: w.address, to, value: amount }] });
  mk(H(51), 2500n * E18);
  let r = await s.call('POST', '/api/issue', { body: await issueBody(w, H(51), await blindMany(s, 3)) });
  assert.equal(r.status, 402);
  r = await s.call('POST', '/api/issue', { body: await issueBody(w, H(51), await blindMany(s, 2)) });
  assert.equal(r.status, 200);
  assert.equal(s.db.get('SELECT kind FROM issued WHERE tx_hash = ?', H(51)).kind, 'burn');
  mk(H(52), 5000n * E18, '0x4444444444444444444444444444444444444444');
  r = await s.call('POST', '/api/issue', { body: await issueBody(w, H(52), await blindMany(s, 1)) });
  assert.equal(r.body.error, 'unsupported_tx');
  mk(H(53), 500n * E18);
  r = await s.call('POST', '/api/issue', { body: await issueBody(w, H(53), await blindMany(s, 1)) });
  assert.equal(r.status, 402);
});

test('0xmock shortcut: 0xmock5c-… = 5 coupons paid by the signer; pending / fail variants', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const w = wallet();
  let r = await s.call('POST', '/api/issue', { body: await issueBody(w, '0xmock5c-abc', await blindMany(s, 5)) });
  assert.equal(r.status, 200);
  r = await s.call('POST', '/api/issue', { body: await issueBody(w, '0xmockpending-1', await blindMany(s, 1)) });
  assert.equal(r.status, 404);
  r = await s.call('POST', '/api/issue', { body: await issueBody(w, '0xmockfail-1', await blindMany(s, 1)) });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'tx_failed');
  assert.equal(await s.rpc.getBalance(MOCK_TREASURY), PRICE * 5n);
});

test('the 0xmock shortcut is rejected when not in mock mode', async (t) => {
  const s = await setup(); t.after(() => s.close());
  s.config.mock = false;
  const r = await s.call('POST', '/api/issue', { body: await issueBody(wallet(), '0xmock5c-abc', await blindMany(s, 1)) });
  assert.equal(r.status, 400);
});

test('500 coupons sign fast', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const w = wallet(), items = await blindMany(s, 500);
  const t0 = Date.now();
  const r = await s.call('POST', '/api/issue', { body: await issueBody(w, '0xmock500c-x', items) });
  assert.equal(r.status, 200); assert.equal(r.body.n, 500);
  assert.ok(Date.now() - t0 < 3000);
});
