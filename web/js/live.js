// Live numbers from GET /api/status (DB + chain). No invented numbers: unknown = "—".

import { getStatus, getKeys } from './api.js';
import { $$, fmtInt, formatEth, formatToken, fmtDate } from './util.js';
import { tokenReady } from './site.js';

let last = null;
const subs = new Set();

export function onStatus(fn) {
  subs.add(fn);
  if (last) fn(last.status, last.error);
  return () => subs.delete(fn);
}

function setStat(name, text, stale = false) {
  for (const n of $$(`[data-stat="${name}"]`)) {
    n.textContent = text;
    n.classList.toggle('stale', stale);
  }
}

async function render(status, error) {
  const token = await tokenReady;
  if (!status) {
    for (const k of ['issued', 'spent', 'purchases', 'eth']) setStat(k, '—', true);
    setStat('updated', 'Status unavailable — retrying');
    return;
  }
  setStat('issued', fmtInt(status.issued));
  setStat('spent', fmtInt(status.spent));
  setStat('purchases', fmtInt(status.purchases));
  const chainDown = status.rpc === 'down' || status.ethReceivedWei === null || status.ethReceivedWei === undefined;
  if (chainDown) {
    setStat('eth', '—', true);
    setStat('eth-note', 'chain read failed, retrying');
  } else {
    setStat('eth', formatEth(status.ethReceivedWei, 5));
    setStat('eth-note', 'treasury, read from chain');
  }
  const showBurn = token.launched && status.token?.address && status.burnedWei !== null && status.burnedWei !== undefined;
  for (const n of $$('[data-burn-cell]')) n.hidden = !(token.launched && status.token?.address);
  if (token.launched && status.token?.address) {
    setStat('burned', showBurn ? formatToken(status.burnedWei) : '—', !showBurn);
  }
  const tally = document.getElementById('tally');
  if (tally) tally.style.setProperty('--cols', token.launched && status.token?.address ? '5' : '4');
  for (const n of $$('[data-n-issued]')) n.textContent = fmtInt(status.issued);
  setStat('updated', `Live · ${new Date().toISOString().slice(11, 19)} UTC${error ? ' · last refresh failed, retrying' : ''}`);
}

async function tick() {
  try {
    const status = await getStatus();
    last = { status, error: null };
  } catch (e) {
    last = { status: last?.status || null, error: e };
  }
  await render(last.status, last.error);
  for (const fn of subs) fn(last.status, last.error);
}

export function startLive(intervalMs = 30000) {
  tick();
  setInterval(() => { if (!document.hidden) tick(); }, intervalMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

/** Fill [data-redeem-until] with the current key's redeemUntil date. */
export async function fillRedeemDate() {
  try {
    const k = await getKeys();
    const cur = (k.keys || []).find((x) => x.id === k.current) || (k.keys || [])[0];
    if (cur?.redeemUntil) for (const n of $$('[data-redeem-until]')) n.textContent = fmtDate(cur.redeemUntil);
    return k;
  } catch {
    return null;
  }
}

export function priceLine(status) {
  if (!status?.priceWei) return null;
  const per = BigInt(status.priceWei);
  const presets = ['500000000000000', '2000000000000000', '10000000000000000'];
  const parts = presets.map((w) => `${formatEth(w)} ETH = ${fmtInt(Number(BigInt(w) / per))}`);
  return `${formatEth(status.priceWei)} ETH per coupon (${parts.join(' · ')}). A fast message costs 1 coupon, a deep one 3.`;
}
