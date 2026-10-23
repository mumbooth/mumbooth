// POST /api/issue and POST /api/hold/claim. Blind-sign a batch after proving who paid / who holds.
import { recoverMessageAddress } from 'viem';
import { ApiError, RpcError, lc, b64, unb64, isAddr, isSig, sha256hex, DEAD, utcDay, nextUtcMidnight } from './util.mjs';
import { KLEN, blindSign } from './blind.mjs';
import { TRANSFER_TOPIC, topicAddr, MOCK_HASH_RE } from './rpc.mjs';

const CHAIN = 4663;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const bad = (m = 'Malformed request.') => new ApiError(400, 'bad_request', m);

export const issueMessage = ({ tx, batch, count }) => `MUMBOOTH issue v1\nchain: ${CHAIN}\ntx: ${tx}\nbatch: ${batch}\ncount: ${count}`;
export const holdMessage = ({ address, day, batch, count }) => `MUMBOOTH hold v1\nchain: ${CHAIN}\naddress: ${address}\nday: ${day}\nbatch: ${batch}\ncount: ${count}`;

function parseBlinded(blinded, max) {
  if (!Array.isArray(blinded) || blinded.length < 1) throw bad('blinded must be a non-empty array.');
  if (blinded.length > max) throw new ApiError(400, 'too_many_coupons', `At most ${max} coupons per request.`, { allowed: max });
  const bufs = blinded.map((b) => unb64(b, KLEN));
  if (bufs.some((b) => !b)) throw bad('Each blinded value must be base64 of 256 bytes.');
  return bufs;
}
const batchHashOf = (bufs) => sha256hex(...bufs);

async function recoverOrFail(message, sig, address) {
  let rec;
  try { rec = await recoverMessageAddress({ message, signature: sig }); } catch { throw new ApiError(401, 'bad_signature', 'Signature could not be verified.'); }
  if (lc(rec) !== address) throw new ApiError(401, 'bad_signature', 'Signature does not match the address.');
}

function signAll(ctx, keyEntry, bufs) {
  try { return bufs.map((b) => b64(blindSign(keyEntry.nodePriv, keyEntry.nodePub, b))); } catch { throw bad('Blinded value rejected.'); }
}

/** Insert the claim row or detect an existing one. Sync, one transaction. Returns the epoch to sign with. */
function claimRow(ctx, { key, address, kind, n, batch }) {
  const epoch = ctx.keys.current;
  return ctx.db.tx(() => {
    const ex = ctx.db.get('SELECT address, epoch, batch_hash FROM issued WHERE tx_hash = ?', key);
    if (ex) {
      if (ex.address !== address) throw new ApiError(403, 'signer_mismatch', 'This transaction belongs to a different wallet.');
      if (ex.batch_hash !== batch) throw kind === 'hold'
        ? new ApiError(409, 'already_claimed', 'Daily coupons already claimed for this wallet.', { nextAt: nextUtcMidnight(ctx.now()) })
        : new ApiError(409, 'tx_used', 'This transaction was already used for a different batch.');
      return ex.epoch;
    }
    ctx.db.run('INSERT INTO issued(tx_hash, address, kind, n, epoch, batch_hash, at) VALUES (?,?,?,?,?,?,?)', key, address, kind, n, epoch, batch, ctx.now());
    return epoch;
  });
}

function respond(ctx, epoch, bufs) {
  const k = ctx.keys.get(epoch);
  return { keyId: epoch, n: bufs.length, blindSigs: signAll(ctx, k, bufs) };
}

function assertIssuable(ctx) {
  const k = ctx.keys.currentKey();
  if (ctx.now() > Date.parse(k.issueUntil)) throw new ApiError(410, 'key_expired', 'The signing key no longer issues coupons.');
}

/** What did this tx pay for? -> {kind, maxN} or throws the right ApiError. */
async function inspectTx(ctx, txHash, signer) {
  const { config, rpc } = ctx;
  let tx, receipt;
  try {
    tx = await rpc.getTransaction(txHash, { from: signer });
    if (tx) receipt = await rpc.getReceipt(txHash);
  } catch (e) { if (e instanceof RpcError) throw new ApiError(503, 'rpc_unavailable', 'Chain RPC unavailable, try again.'); throw e; }
  if (!tx || !receipt) throw new ApiError(404, 'tx_not_found', 'Transaction not found or not confirmed yet.');
  if (receipt.status !== 'success') throw new ApiError(400, 'tx_failed', 'Transaction failed on chain.');
  if (tx.from !== signer) throw new ApiError(403, 'signer_mismatch', 'The signing wallet did not send this transaction.');
  const tok = ctx.token();
  const plain = !tx.input || tx.input === '0x';
  if (tx.to === config.treasury) {
    if (!plain) throw new ApiError(400, 'unsupported_tx', 'Only plain ETH transfers to the treasury are supported.');
    const maxN = tx.value / config.priceWei;
    if (maxN < 1n) throw new ApiError(402, 'underpaid', 'Payment is below the price of one coupon.', { priceWei: config.priceWei.toString() });
    return { kind: 'eth', maxN: Number(maxN > 1_000_000n ? 1_000_000n : maxN) };
  }
  if (!tok.launched) {
    if (!plain) throw new ApiError(409, 'not_launched', 'Burning for coupons opens once the token exists.');
    throw new ApiError(400, 'wrong_recipient', 'Payment was not sent to the treasury.');
  }
  if (tx.to === tok.address) {
    const sum = receipt.logs.filter((l) => lc(l.address) === tok.address && l.topics?.[0] === TRANSFER_TOPIC && lc(l.topics[1] ?? '') === topicAddr(signer) && lc(l.topics[2] ?? '') === topicAddr(DEAD))
      .reduce((a, l) => a + BigInt(l.data), 0n);
    if (sum === 0n) throw new ApiError(400, 'unsupported_tx', 'No token transfer to the burn address found in this transaction.');
    let dec;
    try { dec = await rpc.tokenDecimals(tok.address); } catch { throw new ApiError(503, 'rpc_unavailable', 'Chain RPC unavailable, try again.'); }
    const unit = config.tokensPerCoupon * 10n ** BigInt(dec);
    const maxN = sum / unit;
    if (maxN < 1n) throw new ApiError(402, 'underpaid', 'Burn amount is below the price of one coupon.', { tokensPerCoupon: config.tokensPerCoupon.toString() });
    return { kind: 'burn', maxN: Number(maxN > 1_000_000n ? 1_000_000n : maxN) };
  }
  if (!plain) throw new ApiError(400, 'unsupported_tx', 'Unsupported transaction.');
  throw new ApiError(400, 'wrong_recipient', 'Payment was not sent to the treasury.');
}

export async function issue(ctx, body) {
  const { address, txHash, blinded, sig } = body ?? {};
  if (!isAddr(address) || typeof txHash !== 'string' || !(TX_RE.test(txHash) || (ctx.config.mock && MOCK_HASH_RE.test(txHash.toLowerCase()))) || !isSig(sig)) throw bad();
  const bufs = parseBlinded(blinded, ctx.config.maxPack);
  const addr = lc(address), tx = lc(txHash), batch = batchHashOf(bufs);
  await recoverOrFail(issueMessage({ tx, batch, count: bufs.length }), sig, addr);
  assertIssuable(ctx);

  const ex = ctx.db.get('SELECT address, epoch, batch_hash FROM issued WHERE tx_hash = ?', tx);
  let kind = 'eth';
  if (!ex) {
    const r = await inspectTx(ctx, tx, addr);
    kind = r.kind;
    if (bufs.length > r.maxN) throw new ApiError(402, 'underpaid', `Payment covers ${r.maxN} coupon(s), requested ${bufs.length}.`, { priceWei: ctx.config.priceWei.toString(), paidFor: r.maxN });
  }
  signAll(ctx, ctx.keys.currentKey(), bufs); // dry-run: reject malformed values before a row is written
  const epoch = claimRow(ctx, { key: tx, address: addr, kind, n: bufs.length, batch });
  return respond(ctx, epoch, bufs);
}

export async function holdClaim(ctx, body) {
  const { address, day, blinded, sig } = body ?? {};
  if (!isAddr(address) || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !isSig(sig)) throw bad();
  const tok = ctx.token();
  if (!tok.holdLaunched) throw new ApiError(409, 'not_launched', 'Daily coupons open once the token exists.');
  if (day !== utcDay(ctx.now())) throw new ApiError(400, 'bad_day', 'day must be today (UTC).');
  const bufs = parseBlinded(blinded, ctx.config.holdPerDay);
  const addr = lc(address), batch = batchHashOf(bufs);
  await recoverOrFail(holdMessage({ address: addr, day, batch, count: bufs.length }), sig, addr);
  assertIssuable(ctx);
  const key = `hold:${addr}:${day}`;
  const ex = ctx.db.get('SELECT batch_hash FROM issued WHERE tx_hash = ?', key);
  if (!ex) {
    let bal, dec;
    try { dec = await ctx.rpc.tokenDecimals(tok.address); bal = await ctx.rpc.tokenBalance(tok.address, addr); } catch { throw new ApiError(503, 'rpc_unavailable', 'Chain RPC unavailable, try again.'); }
    const unit = 10n ** BigInt(dec);
    if (bal < ctx.config.holdMin * unit) throw new ApiError(403, 'below_minimum', 'Balance is below the holder minimum.', { holdMin: ctx.config.holdMin.toString(), balance: (bal / unit).toString() });
  }
  signAll(ctx, ctx.keys.currentKey(), bufs);
  const epoch = claimRow(ctx, { key, address: addr, kind: 'hold', n: bufs.length, batch });
  return respond(ctx, epoch, bufs);
}
