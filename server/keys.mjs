// Key store: /var/lib/mumbooth/keys/<id>.pem (PKCS8, 0600) + <id>.json {issueUntil, redeemUntil}. k1 is created on first start.
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { ALG, MODULUS_BITS, generateKeyPair, suite } from './blind.mjs';
import { b64 } from './util.mjs';

const ALGO = { name: 'RSA-PSS', hash: 'SHA-384' };

export async function loadKeys({ dir, currentId = 'k1', now = Date.now, issueDays = 30, redeemDays = 60, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const first = path.join(dir, `${currentId}.pem`);
  if (!fs.existsSync(first)) {
    const kp = await generateKeyPair();
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END PRIVATE KEY-----\n`;
    fs.writeFileSync(first, pem, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(dir, `${currentId}.json`), JSON.stringify({
      issueUntil: new Date(now() + issueDays * 86400_000).toISOString(), redeemUntil: new Date(now() + redeemDays * 86400_000).toISOString(),
    }, null, 2), { mode: 0o600 });
    log(`key ${currentId} created`);
  }
  const keys = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => /^[A-Za-z0-9_-]+\.pem$/.test(x)).sort()) {
    const id = f.slice(0, -4);
    const nodePriv = createPrivateKey(fs.readFileSync(path.join(dir, f)));
    const nodePub = createPublicKey(nodePriv);
    const spkiDer = nodePub.export({ type: 'spki', format: 'der' });
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); } catch {}
    const issueUntil = meta.issueUntil ?? new Date(now() + issueDays * 86400_000).toISOString();
    const redeemUntil = meta.redeemUntil ?? new Date(now() + redeemDays * 86400_000).toISOString();
    const publicKey = await crypto.subtle.importKey('spki', spkiDer, ALGO, true, ['verify']);
    const fingerprint = 'sha256:' + createHash('sha256').update(spkiDer).digest('hex');
    keys.set(id, { id, nodePriv, nodePub, publicKey, spki: b64(spkiDer), fingerprint, issueUntil, redeemUntil });
    log(`key ${id} fingerprint ${fingerprint}`);
  }
  if (!keys.has(currentId)) throw new Error(`current key ${currentId} missing`);
  return {
    current: currentId,
    get: (id) => keys.get(id),
    currentKey: () => keys.get(currentId),
    publicList: () => [...keys.values()].map((k) => ({ id: k.id, alg: ALG, modulusBits: MODULUS_BITS, spki: k.spki, fingerprint: k.fingerprint, issueUntil: k.issueUntil, redeemUntil: k.redeemUntil })),
    suite,
  };
}
