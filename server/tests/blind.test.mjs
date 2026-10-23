import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup, blindMany, finalize } from './helpers.mjs';
import { suite, verifyCoupon, generateKeyPair, blindSign, ALG } from '../blind.mjs';
import { b64 } from '../util.mjs';

test('blind -> blindSign -> finalize -> verify; wrong key / altered msg / altered sig fail', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const k = s.keys.currentKey();
  const [it] = await blindMany(s, 1);
  const bs = blindSign(k.nodePriv, k.nodePub, Buffer.from(it.blindedMsg));
  const sig = await suite.finalize(k.publicKey, it.msg, bs, it.inv);
  assert.equal(await verifyCoupon(k.publicKey, it.msg, sig), true);
  const other = await generateKeyPair();
  const otherPub = await crypto.subtle.importKey('spki', await crypto.subtle.exportKey('spki', other.publicKey), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  assert.equal(await verifyCoupon(otherPub, it.msg, sig), false, 'other key');
  const msg2 = Uint8Array.from(it.msg); msg2[0] ^= 1;
  assert.equal(await verifyCoupon(k.publicKey, msg2, sig), false, 'msg altered');
  const sig2 = Uint8Array.from(sig); sig2[10] ^= 1;
  assert.equal(await verifyCoupon(k.publicKey, sig2, it.msg), false, 'sig altered');
});

test('fast node:crypto signing is byte-identical to the library blindSign', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const k = s.keys.currentKey();
  const privJwkKey = await crypto.subtle.importKey('pkcs8', k.nodePriv.export({ type: 'pkcs8', format: 'der' }), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
  for (const it of await blindMany(s, 2)) {
    const fast = blindSign(k.nodePriv, k.nodePub, Buffer.from(it.blindedMsg));
    const lib = await suite.blindSign(privJwkKey, it.blindedMsg);
    assert.equal(b64(fast), b64(lib));
  }
});

test('/api/keys shape, fingerprint = sha256(SPKI), suite name', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const r = await s.call('GET', '/api/keys');
  assert.equal(r.status, 200);
  assert.equal(r.body.current, 'k1');
  const [k] = r.body.keys;
  assert.deepEqual(Object.keys(k).sort(), ['alg', 'fingerprint', 'id', 'issueUntil', 'modulusBits', 'redeemUntil', 'spki']);
  assert.equal(k.alg, 'RSABSSA-SHA384-PSS-Deterministic');
  assert.equal(ALG, k.alg);
  assert.equal(k.modulusBits, 2048);
  assert.equal(k.fingerprint, 'sha256:' + createHash('sha256').update(Buffer.from(k.spki, 'base64')).digest('hex'));
  assert.ok(Date.parse(k.redeemUntil) > Date.parse(k.issueUntil));
});

test('key file is created on first start (0600) and reused afterwards', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { loadKeys } = await import('../keys.mjs');
  const fs = await import('node:fs'); const path = await import('node:path');
  const dir = path.join(s.config.dataDir, 'keys');
  assert.equal(fs.statSync(path.join(dir, 'k1.pem')).mode & 0o777, 0o600);
  const again = await loadKeys({ dir, currentId: 'k1' });
  assert.equal(again.currentKey().fingerprint, s.keys.currentKey().fingerprint);
});

test('finalize helper round-trip via API is exercised in issue.test', () => { assert.ok(finalize); });
