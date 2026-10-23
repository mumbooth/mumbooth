// Test harness: in-memory db, temp data dir for keys, mock chain, scripted model, controllable clock. No network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { loadConfig, MOCK_TREASURY } from '../config.mjs';
import { createContext } from '../context.mjs';
import { buildApp } from '../app.mjs';
import { createMockRpc } from '../rpc.mjs';
import { createMockModel } from '../model.mjs';
import { createTrial } from '../trial.mjs';
import { loadKeys } from '../keys.mjs';
import { openDb } from '../db.mjs';
import { suite, KLEN } from '../blind.mjs';
import { issueMessage, holdMessage } from '../issue.mjs';
import { b64, sha256hex } from '../util.mjs';

export const TOKEN = '0x2222222222222222222222222222222222222222';
export const DEAD = '0x000000000000000000000000000000000000dead';

/** A model whose behaviour tests script. fails: 'before' | 'after' | null. */
export function scriptedModel({ chunks = ['Hello', ' world'], fail = null, gate = null, calls = [] } = {}) {
  return {
    kind: 'scripted',
    async *stream(args) {
      calls.push(args);
      if (gate) await gate;
      if (fail === 'before') throw Object.assign(new Error('boom'), { status: 529 });
      for (let i = 0; i < chunks.length; i++) {
        yield chunks[i];
        if (fail === 'after' && i === 0) throw Object.assign(new Error('boom'), { status: 500 });
      }
    },
  };
}

export async function setup({ env = {}, model, now: nowFn, logStream, token = null, mockModelDelay } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mumbooth-test-'));
  const tokenPath = path.join(dir, 'token.json');
  const writeToken = (address) => fs.writeFileSync(tokenPath, JSON.stringify({ address: address ?? '0x0000000000000000000000000000000000000000', symbol: address ? 'MUM' : null, chainId: 4663 }));
  writeToken(token);
  const clock = { t: nowFn ?? Date.UTC(2026, 9, 24, 12, 0, 0) };
  const now = () => clock.t;
  const config = { ...loadConfig({ RPC_MODE: 'mock', MODEL_MODE: 'mock', DATA_DIR: dir, TOKEN_JSON: tokenPath, ...env }), statusTtlMs: 0, logLevel: logStream ? 'info' : 'silent' };
  const db = openDb(':memory:');
  const rpc = createMockRpc({ treasury: config.treasury, priceWei: config.priceWei });
  const keys = await loadKeys({ dir: path.join(dir, 'keys'), currentId: 'k1', now });
  const trial = createTrial({ perDay: 3, cap: config.trialDailyCap, now });
  const ctx = createContext({ config, db, rpc, keys, model: model ?? createMockModel({ delayMs: 0 }), trial, now });
  const app = await buildApp(ctx, { logStream });
  await app.ready();
  const call = async (method, url, { body, headers, remoteAddress } = {}) => {
    const r = await app.inject({ method, url, payload: body, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, remoteAddress });
    let json = null;
    try { json = JSON.parse(r.body); } catch {}
    return { status: r.statusCode, body: json, text: r.body, headers: r.headers };
  };
  return {
    ctx, app, db, rpc, keys, config, clock, call, writeToken: (a) => { writeToken(a); ctx.reloadToken(); },
    close: async () => { await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

export function wallet() { const account = privateKeyToAccount(generatePrivateKey()); return account; }

/** Browser-side: make n coupons' blinded state against the server's current public key. */
export async function blindMany(s, n) {
  const k = s.keys.currentKey();
  const items = [];
  for (let i = 0; i < n; i++) {
    const msg = crypto.getRandomValues(new Uint8Array(32));
    const { blindedMsg, inv } = await suite.blind(k.publicKey, msg);
    items.push({ msg, blindedMsg, inv });
  }
  return items;
}
export const batchOf = (items) => sha256hex(...items.map((i) => Buffer.from(i.blindedMsg)));

/** Build an /api/issue body signed by `account` for tx. */
export async function issueBody(account, txHash, items) {
  const batch = batchOf(items);
  const sig = await account.signMessage({ message: issueMessage({ tx: txHash.toLowerCase(), batch, count: items.length }) });
  return { address: account.address, txHash, blinded: items.map((i) => b64(i.blindedMsg)), sig };
}
export async function holdBody(account, day, items) {
  const batch = batchOf(items);
  const sig = await account.signMessage({ message: holdMessage({ address: account.address.toLowerCase(), day, batch, count: items.length }) });
  return { address: account.address, day, blinded: items.map((i) => b64(i.blindedMsg)), sig };
}

/** Finalize blind signatures into coupons {epoch,msg,sig} (asserts each verifies). */
export async function finalize(s, items, res) {
  const k = s.keys.get(res.keyId);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const sig = await suite.finalize(k.publicKey, items[i].msg, Buffer.from(res.blindSigs[i], 'base64'), items[i].inv);
    out.push({ epoch: res.keyId, msg: b64(items[i].msg), sig: b64(sig) });
  }
  return out;
}

/** Issue n real coupons through the API using the 0xmock shortcut. */
let nonce = 0;
export async function buyCoupons(s, n, account = wallet()) {
  const items = await blindMany(s, n);
  const txHash = `0xmock${n}c-t${++nonce}`;
  const r = await s.call('POST', '/api/issue', { body: await issueBody(account, txHash, items) });
  if (r.status !== 200) throw new Error('buy failed ' + r.text);
  return finalize(s, items, r.body);
}

export function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((blk) => {
    const ev = /^event: (.+)$/m.exec(blk)?.[1];
    const data = /^data: (.+)$/m.exec(blk)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}
export const chatBody = (coupons, extra = {}) => ({ mode: 'coupon', model: 'fast', coupons, messages: [{ role: 'user', content: 'hi there' }], ...extra });
export { MOCK_TREASURY, KLEN };
