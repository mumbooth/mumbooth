import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { setup, wallet, blindMany, issueBody, finalize, chatBody, scriptedModel, batchOf } from './helpers.mjs';

test('logs: no ip, wallet address, tx hash, coupon, message text, user-agent or blinded data - across issue + chat + errors', async (t) => {
  const lines = [];
  const logStream = new Writable({ write(chunk, _e, cb) { lines.push(chunk.toString()); cb(); } });
  const s = await setup({ logStream, model: scriptedModel({ chunks: ['SECRET-ANSWER'] }) });
  t.after(() => s.close());
  const IP = '203.0.113.77', UA = 'MumboothTestAgent/9.9', TEXT = 'my very private question 4711';
  const w = wallet(), items = await blindMany(s, 3), txHash = '0xmock3c-privacycheck';
  const body = await issueBody(w, txHash, items);
  const headers = { 'user-agent': UA, 'x-forwarded-for': IP };
  let r = await s.call('POST', '/api/issue', { body, headers, remoteAddress: IP });
  assert.equal(r.status, 200);
  await s.call('POST', '/api/issue', { body: { ...body, sig: '0x' + '22'.repeat(65) }, headers, remoteAddress: IP }); // 401 path
  const coupons = await finalize(s, items, r.body);
  const msgs = [{ role: 'user', content: TEXT }];
  await s.call('POST', '/api/chat', { body: chatBody([coupons[0]], { messages: msgs }), headers, remoteAddress: IP });
  await s.call('POST', '/api/chat', { body: chatBody([coupons[0]], { messages: msgs }), headers, remoteAddress: IP });   // 409 spent
  await s.call('POST', '/api/chat', { body: { mode: 'trial', messages: msgs }, headers, remoteAddress: IP });             // trial
  s.ctx.model = scriptedModel({ fail: 'before' });
  await s.call('POST', '/api/chat', { body: chatBody([coupons[1]], { messages: msgs }), headers, remoteAddress: IP });   // refunded failure
  s.ctx.model = scriptedModel({ fail: 'after' });
  await s.call('POST', '/api/chat', { body: chatBody([coupons[2]], { messages: msgs }), headers, remoteAddress: IP });   // mid-stream failure
  await s.call('POST', '/api/chat', { body: { garbage: true }, headers, remoteAddress: IP });
  s.rpc.setDown(true);
  await s.call('GET', '/api/status', { headers, remoteAddress: IP });
  await s.call('POST', '/api/issue', { body: await issueBody(w, '0xmock1c-other', await blindMany(s, 1)), headers, remoteAddress: IP });
  const all = lines.join('');
  assert.ok(lines.length >= 8, 'one line per request');
  const forbidden = [IP, '203.0.113', UA, 'MumboothTestAgent', TEXT, 'SECRET-ANSWER', w.address, w.address.toLowerCase(), w.address.slice(2, 12).toLowerCase(), txHash,
    body.sig, batchOf(items), ...coupons.flatMap((c) => [c.msg, c.sig]), ...body.blinded.map((b) => b.slice(0, 40)), 'authorization', 'x-forwarded-for'];
  for (const bad of forbidden) assert.ok(!all.toLowerCase().includes(String(bad).toLowerCase()), `leaked: ${String(bad).slice(0, 24)}`);
  assert.match(all, /"route":"\/api\/chat"/);
  assert.match(all, /"route":"\/api\/issue"/);
  const first = JSON.parse(lines.find((l) => l.includes('"msg":"req"')));
  assert.deepEqual(Object.keys(first).filter((k) => ['method', 'route', 'status', 'ms'].includes(k)).sort(), ['method', 'ms', 'route', 'status']);
  assert.ok(!('req' in first) && !('res' in first) && !('reqId' in first));
});
