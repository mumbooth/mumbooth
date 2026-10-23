#!/usr/bin/env node
// MUMBOOTH end-to-end check against a LIVE deployment (mainnet, real ETH). Run by the lead after deploy; agents never run it.
//   E2E_PK=0x…  (fresh funded key, ~0.001 ETH)  E2E_BASE=https://mumbooth.chat  [E2E_RPC=https://robinhood-rpc.publicnode.com]  [E2E_COUNT=5]
//   node tools/e2e.mjs
// Flow: /api/status + /api/keys -> blind N msgs -> send N*PRICE_WEI to treasury -> wait receipt -> personal_sign -> POST /api/issue
//       -> finalize + verify -> POST /api/chat with 1 coupon (prints the stream) -> same coupon again => 409 coupon_spent
//       -> POST /api/issue again, same batch => identical blindSigs -> summary + explorer link.
// Dependencies are resolved from ../server/node_modules (viem, @cloudflare/blindrsa-ts); run `npm install` in server/ first.
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server');
const req = createRequire(path.join(serverDir, 'package.json'));
const viem = req('viem');
const { privateKeyToAccount } = req('viem/accounts');
const { RSABSSA } = await import(pathToFileURL(req.resolve('@cloudflare/blindrsa-ts')).href);

const PK = process.env.E2E_PK, BASE = (process.env.E2E_BASE || '').replace(/\/$/, '');
const RPC = process.env.E2E_RPC || 'https://robinhood-rpc.publicnode.com';
const N = Number(process.env.E2E_COUNT || 5);
if (!/^0x[0-9a-fA-F]{64}$/.test(PK || '') || !BASE) { console.error('Set E2E_PK (0x + 64 hex) and E2E_BASE (e.g. https://mumbooth.chat)'); process.exit(2); }

let failed = 0;
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { failed++; console.log('  FAIL ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));
const step = (m) => console.log('\n' + m);
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

const account = privateKeyToAccount(PK);
console.log(`MUMBOOTH e2e · ${BASE} · wallet ${account.address} · ${N} coupons`);

step('1. status + keys');
const st = (await api('GET', '/api/status')).json;
const ks = (await api('GET', '/api/keys')).json;
check(st?.chainId === 4663, `chainId 4663`);
const key = ks.keys.find((k) => k.id === ks.current);
const fp = 'sha256:' + createHash('sha256').update(Buffer.from(key.spki, 'base64')).digest('hex');
check(fp === key.fingerprint, `fingerprint matches SPKI (${key.fingerprint})`);
check(key.alg === 'RSABSSA-SHA384-PSS-Deterministic' && key.modulusBits === 2048, 'suite + modulus');
const suite = RSABSSA.SHA384.PSS.Deterministic();
const pub = await crypto.subtle.importKey('spki', unb64(key.spki), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
const price = BigInt(st.priceWei);
console.log(`  price ${price} wei · treasury ${st.treasury} · issued so far ${st.issued}`);

step(`2. blind ${N} messages`);
const items = [];
for (let i = 0; i < N; i++) {
  const msg = crypto.getRandomValues(new Uint8Array(32));
  const { blindedMsg, inv } = await suite.blind(pub, msg);
  items.push({ msg, blindedMsg, inv });
}
const batch = createHash('sha256').update(Buffer.concat(items.map((i) => Buffer.from(i.blindedMsg)))).digest('hex');
ok('blinded');

step('3. pay the treasury on Robinhood Chain (this sends a REAL transaction)');
const chain = viem.defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) });
const wc = viem.createWalletClient({ account, chain, transport: viem.http(RPC) });
const value = price * BigInt(N);
const bal = await pc.getBalance({ address: account.address });
console.log(`  balance ${viem.formatEther(bal)} ETH · paying ${viem.formatEther(value)} ETH`);
if (bal < value + 10n ** 14n) { console.error('Not enough ETH on 4663 for payment + gas.'); process.exit(1); }
const txHash = (await wc.sendTransaction({ to: st.treasury, value })).toLowerCase();
console.log(`  tx ${txHash}`);
await pc.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
ok('receipt confirmed');

step('4. personal_sign + /api/issue');
const message = `MUMBOOTH issue v1\nchain: 4663\ntx: ${txHash}\nbatch: ${batch}\ncount: ${N}`;
const sig = await account.signMessage({ message });
const issueBody = { address: account.address, txHash, blinded: items.map((i) => b64(i.blindedMsg)), sig };
let r1;
for (let i = 0; i < 60; i++) { // the server may still see the tx as pending for a few seconds
  r1 = await api('POST', '/api/issue', issueBody);
  if (r1.status !== 404 && r1.status !== 503) break;
  await new Promise((r) => setTimeout(r, 3000));
}
check(r1.status === 200, `issue -> ${r1.status} ${r1.status === 200 ? '' : r1.text}`);
if (r1.status !== 200) process.exit(1);
check(r1.json.n === N && r1.json.blindSigs.length === N && r1.json.keyId === key.id, `n=${r1.json.n} keyId=${r1.json.keyId}`);

step('5. finalize + verify every coupon');
const coupons = [];
for (let i = 0; i < N; i++) {
  const sigBytes = await suite.finalize(pub, items[i].msg, unb64(r1.json.blindSigs[i]), items[i].inv);
  const good = await suite.verify(pub, sigBytes, items[i].msg);
  if (!good) bad(`coupon ${i} does not verify`);
  coupons.push({ epoch: r1.json.keyId, msg: b64(items[i].msg), sig: b64(sigBytes) });
}
check(coupons.length === N, `${N} coupons verified against the published key`);

step('6. chat with 1 coupon (fast)');
const chatReq = { mode: 'coupon', model: 'fast', coupons: [coupons[0]], messages: [{ role: 'user', content: 'Say hello in five words.' }] };
const cr = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chatReq) });
check(cr.status === 200 && /text\/event-stream/.test(cr.headers.get('content-type') || ''), `chat -> ${cr.status} ${cr.headers.get('content-type')}`);
let sse = '';
if (cr.status === 200) {
  const dec = new TextDecoder();
  process.stdout.write('  stream: ');
  for await (const chunk of cr.body) {
    const t = dec.decode(chunk, { stream: true });
    sse += t;
    for (const m of t.matchAll(/event: delta\ndata: (.+)/g)) process.stdout.write(JSON.parse(m[1]).text);
  }
  process.stdout.write('\n');
  check(/event: meta/.test(sse) && /event: done/.test(sse), 'meta ... done received');
  if (/event: error/.test(sse)) bad('stream contained an error event');
}

step('7. same coupon again -> 409 coupon_spent');
const again = await api('POST', '/api/chat', chatReq);
check(again.status === 409 && again.json?.error === 'coupon_spent', `second use -> ${again.status} ${again.json?.error}`);

step('8. re-claim with the same batch -> identical blindSigs');
const r2 = await api('POST', '/api/issue', issueBody);
check(r2.status === 200 && JSON.stringify(r2.json.blindSigs) === JSON.stringify(r1.json.blindSigs), `re-issue -> ${r2.status}, identical: ${r2.status === 200 && JSON.stringify(r2.json.blindSigs) === JSON.stringify(r1.json.blindSigs)}`);

step('summary');
const after = (await api('GET', '/api/status')).json;
console.log(`  coupons issued ${st.issued} -> ${after.issued} · spent ${st.spent} -> ${after.spent} · purchases ${st.purchases} -> ${after.purchases}`);
console.log(`  tx: ${st.explorer.replace(/\/$/, '')}/tx/${txHash}`);
console.log(`  unspent coupons left in this run: ${N - 1} (not persisted; the wallet key ${account.address} is disposable)`);
console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
