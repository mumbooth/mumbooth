// Blind coupons: RSABSSA-SHA384-PSS-Deterministic (RFC 9474), 2048-bit keys.
// The vendor bundle is @cloudflare/blindrsa-ts@0.4.6, unminified (built by the server's bundle script).

import { RSABSSA } from './vendor/blindrsa.js';
import { getKeys } from './api.js';
import { cacheKey, getCachedKey } from './coupons.js';
import { b64decode, b64encode, concatBytes, hex, sha256 } from './util.js';
import { ClientError } from './errors.js';

export const SUITE_NAME = 'RSABSSA-SHA384-PSS-Deterministic';
const suite = RSABSSA.SHA384.PSS.Deterministic();

function needCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) throw new ClientError('crypto_unavailable');
}

/** Import an SPKI (base64 DER) RSA-PSS/SHA-384 public key. Must be extractable: the lib exports it as JWK. */
export async function importPublicKey(spkiB64) {
  needCrypto();
  return crypto.subtle.importKey('spki', b64decode(spkiB64), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
}

/** sha256:<hex> of the SPKI DER — must match the fingerprint the server publishes. */
export async function fingerprintOf(spkiB64) {
  return 'sha256:' + hex(await sha256(b64decode(spkiB64)));
}

const keyObjects = new Map(); // id -> CryptoKey

/**
 * Load /api/keys, check each key's fingerprint against the SPKI and against our cache.
 * Returns {current, keys:[...], changed:[{id, was, now}], byId: Map}.
 * A changed fingerprint is reported (UI warns) but does not stop the flow.
 */
export async function loadKeys() {
  const data = await getKeys();
  const keys = Array.isArray(data.keys) ? data.keys : [];
  const changed = [];
  const byId = new Map();
  for (const k of keys) {
    const fp = await fingerprintOf(k.spki);
    const selfConsistent = !k.fingerprint || k.fingerprint.toLowerCase() === fp;
    const cached = await getCachedKey(k.id);
    if (cached && cached.fingerprint !== fp) changed.push({ id: k.id, was: cached.fingerprint, now: fp });
    const rec = { ...k, fingerprint: fp, selfConsistent };
    byId.set(k.id, rec);
    await cacheKey(rec).catch(() => {});
  }
  return { current: data.current, keys: [...byId.values()], changed, byId };
}

export async function keyObject(rec) {
  const cacheId = rec.id + ':' + rec.fingerprint;
  if (!keyObjects.has(cacheId)) keyObjects.set(cacheId, await importPublicKey(rec.spki));
  return keyObjects.get(cacheId);
}

/** Epoch ids whose coupons can still be redeemed now. */
export function redeemableEpochs(keys, now = Date.now()) {
  const s = new Set();
  for (const k of keys) {
    const until = k.redeemUntil ? Date.parse(k.redeemUntil) : NaN;
    if (Number.isNaN(until) || until > now) s.add(k.id);
  }
  return s;
}

/**
 * Make N random 32-byte messages and blind them with the key.
 * Returns {msgs[], inv[], blinded[]} as base64 strings, plus batchHash (hex).
 */
export async function makeBatch(keyRec, n) {
  needCrypto();
  const pk = await keyObject(keyRec);
  const msgs = [], inv = [], blinded = [];
  for (let i = 0; i < n; i++) {
    const msg = crypto.getRandomValues(new Uint8Array(32));
    const prepared = suite.prepare(msg); // Deterministic: identity
    const out = await suite.blind(pk, prepared);
    msgs.push(b64encode(prepared));
    inv.push(b64encode(out.inv));
    blinded.push(b64encode(out.blindedMsg));
  }
  return { msgs, inv, blinded, batchHash: await batchHash(blinded) };
}

/** sha256 hex of concat(blinded bytes, in order) — the "batch:" line of the signed claim. */
export async function batchHash(blindedB64) {
  return hex(await sha256(concatBytes(blindedB64.map(b64decode))));
}

/**
 * Unblind the server's blind signatures and verify every coupon against the public key.
 * Throws ClientError('verify_failed') if any fails (nothing is saved in that case).
 */
export async function finalizeBatch(keyRec, msgs, inv, blindSigs) {
  if (!Array.isArray(blindSigs) || blindSigs.length !== msgs.length) {
    throw new ClientError('verify_failed', 'Wrong number of signatures');
  }
  const pk = await keyObject(keyRec);
  const coupons = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = b64decode(msgs[i]);
    let sig;
    try {
      sig = await suite.finalize(pk, m, b64decode(blindSigs[i]), b64decode(inv[i]));
    } catch {
      throw new ClientError('verify_failed');
    }
    const ok = await suite.verify(pk, sig, m);
    if (!ok) throw new ClientError('verify_failed');
    coupons.push({ epoch: keyRec.id, msg: msgs[i], sig: b64encode(sig) });
  }
  return coupons;
}

/** Verify a coupon {epoch,msg,sig} against a key record (used for imports). */
export async function verifyCoupon(keyRec, c) {
  try {
    const pk = await keyObject(keyRec);
    return await suite.verify(pk, b64decode(c.sig), b64decode(c.msg));
  } catch {
    return false;
  }
}
