// /booth — Chat · Coupons · Buy · Forget.
import { tokenReady } from './site.js';
import { createChat, COST } from './chat.js';
import { getStatus, postIssue, postHoldClaim, ApiError } from './api.js';
import { humanError, ClientError } from './errors.js';
import * as store from './coupons.js';
import * as wallet from './wallet.js';
import { loadKeys, makeBatch, finalizeBatch, redeemableEpochs, verifyCoupon } from './blind.js';
import {
  $, $$, el, clear, fmtInt, formatEth, parseEth, shortHex, fmtDate, fmtDateTime, utcDay, sleep, download,
} from './util.js';

const PRESETS = ['500000000000000', '2000000000000000', '10000000000000000']; // 0.0005 / 0.002 / 0.01 ETH
const CLAIM_RETRY_MS = 3000;
const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

const justSpent = new Set();
const state = {
  status: null,
  keys: null,          // {current, keys, byId, changed}
  token: null,
  method: 'eth',
  presetWei: PRESETS[0],
  customEth: '',
  busy: false,
};

// ---------------- banners ----------------
const banners = $('#banners');
function banner(id, text, warn = true) {
  let n = document.getElementById('banner-' + id);
  if (!n) {
    n = el('p', { id: 'banner-' + id, class: 'notice banner' + (warn ? ' warn' : ''), role: 'status' });
    banners.append(n);
  }
  clear(n);
  if (Array.isArray(text)) n.append(...text); else n.textContent = text;
}

// ---------------- keys / status ----------------
let keysPromise = null;
function ensureKeys(force = false) {
  if (!keysPromise || force) {
    keysPromise = loadKeys().then((k) => {
      state.keys = k;
      if (k.changed.length) {
        banner('key', [el('strong', { text: 'Signing key changed. ' }),
          `The server’s key ${k.changed.map((c) => c.id).join(', ')} no longer matches the fingerprint this browser saw before (${k.changed.map((c) => shortHex(c.was, 14, 6) + ' → ' + shortHex(c.now, 14, 6)).join('; ')}). Compare with the fingerprint published on X and in /docs before buying.`]);
      }
      const bad = k.keys.filter((x) => !x.selfConsistent);
      if (bad.length) banner('keyfp', 'The server’s published fingerprint does not match its own key data. Do not buy until this is explained.');
      for (const n of $$('[data-redeem-until]')) {
        const cur = k.byId.get(k.current);
        if (cur?.redeemUntil) n.textContent = fmtDate(cur.redeemUntil);
      }
      return k;
    }).catch((e) => { keysPromise = null; throw e; });
  }
  return keysPromise;
}
async function epochs() {
  try { const k = await ensureKeys(); return redeemableEpochs(k.keys); } catch { return null; }
}
async function refreshStatus() {
  try { state.status = await getStatus(); } catch { /* keep last */ }
  renderAnon();
  renderBuyForm();
  return state.status;
}

// ---------------- tabs ----------------
const TABS = ['chat', 'coupons', 'buy', 'forget'];
function showTab() {
  const want = (location.hash || '#chat').slice(1);
  const tab = TABS.includes(want) ? want : 'chat';
  for (const t of TABS) {
    $('#panel-' + t).hidden = t !== tab;
    $('#tab-' + t).setAttribute('aria-selected', String(t === tab));
  }
  if (tab === 'coupons') renderCoupons();
  if (tab === 'buy') { renderPending(); renderBuyForm(); }
  if (tab === 'forget') renderForget();
}
window.addEventListener('hashchange', showTab);

// ---------------- chat + booth list ----------------
const chat = createChat($('#chat'), {
  kind: 'booth',
  title: 'Booth',
  getEpochs: epochs,
  onSaved: () => renderBoothList(),
  onSpent: (ids) => { for (const i of ids) justSpent.add(i); renderCoupons(); },
});

async function renderBoothList() {
  const list = $('#booth-list');
  const booths = await store.listBooths();
  clear(list);
  if (!booths.length) list.append(el('li', {}, el('span', { class: 'none', text: 'No saved booths yet.' })));
  for (const b of booths) {
    list.append(el('li', {}, el('button', {
      type: 'button', 'aria-current': String(b.id === chat.boothId), title: b.title,
      text: b.title || 'Untitled booth',
      onclick: () => { chat.load(b); renderBoothList(); },
    })));
  }
}
$('#new-booth').addEventListener('click', () => { chat.load(null); renderBoothList(); chat.focus(); });

// ---------------- coupons ----------------
async function renderCoupons() {
  const all = await store.listCoupons();
  const ep = await epochs();
  const usable = all.filter((c) => c.status === 'ok' && (!ep || ep.has(c.epoch)));
  const spent = all.filter((c) => c.status === 'spent');
  for (const n of $$('[data-usable]')) n.textContent = fmtInt(usable.length);
  $('[data-spent-here]').textContent = fmtInt(spent.length);
  $('[data-fast-left]').textContent = fmtInt(Math.floor(usable.length / COST.fast));
  $('[data-deep-left]').textContent = fmtInt(Math.floor(usable.length / COST.deep));

  const grid = $('#tickets');
  if ($('#panel-coupons').hidden) return;
  clear(grid);
  const show = [...all].reverse().slice(0, 120);
  for (const c of show) grid.append(ticketNode(c, ep));
  $('#tickets-more').textContent = all.length > show.length ? `+ ${fmtInt(all.length - show.length)} older tickets not shown` : (all.length ? '' : 'No coupons yet. Buy a pack in the Buy tab.');
}
function ticketNode(c, ep) {
  const expired = c.status === 'expired' || (ep && !ep.has(c.epoch));
  const cls = 'ticket ' + (c.status === 'spent' ? 'spent' : c.status === 'inflight' ? 'inflight' : (c.status === 'invalid' || expired) ? 'invalid' : '');
  const label = c.status === 'spent' ? 'spent' : c.status === 'inflight' ? 'in use' : c.status === 'invalid' ? 'invalid' : expired ? 'expired' : 'valid';
  const node = el('div', { class: cls, title: `coupon ${c.no} · ${label}` },
    el('span', { class: 'n', text: '№ ' + String(c.no).padStart(4, '0') }),
    el('span', { class: 'h', text: c.msg.slice(0, 16) + '…' }),
    el('span', { class: 'h', text: label }),
    el('span', { class: 'ep', text: c.epoch }),
    el('span', { class: 'hole', 'aria-hidden': 'true' }));
  if (c.status === 'spent') node.append(el('span', { class: 'stamp', 'aria-hidden': 'true', text: 'Spent' }));
  if (justSpent.has(c.id)) node.classList.add('punch');
  return node;
}
store.onChange((d) => {
  if (!d.store || d.store === 'coupons') renderCoupons();
  if (d.store === 'pending') renderPending();
  if (d.store === 'booths' && d.remote) renderBoothList();
});

function renderAnon() {
  const s = state.status;
  if (!s) { $('[data-anon-line]').textContent = 'Could not load the live count.'; return; }
  const keyId = s.keyId || 'k1';
  const n = s.issuedByKey && s.issuedByKey[keyId] !== undefined ? s.issuedByKey[keyId] : s.issued;
  $('[data-anon-line]').textContent = `Issued with key ${keyId}: ${fmtInt(n)} coupons from ${fmtInt(s.purchases)} purchase${s.purchases === 1 ? '' : 's'}.`;
  $('[data-key-line]').textContent = `key ${keyId}`;
}

$('#export-btn').addEventListener('click', exportFile);
$('#forget-export').addEventListener('click', exportFile);
async function exportFile() {
  const text = await store.exportCoupons();
  const n = JSON.parse(text).coupons.length;
  if (!n) { say('#coupon-msg', 'No unspent coupons to export.'); say('#forget-msg', 'No unspent coupons to export.'); return; }
  download(`mumbooth-coupons-${utcDay()}.json`, text);
  say('#coupon-msg', `Exported ${n} coupons. Keep the file private — it spends like cash.`);
  say('#forget-msg', `Exported ${n} coupons.`);
}
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const list = store.parseCouponFile(await file.text());
    const k = await ensureKeys();
    const good = [];
    let bad = 0, unknown = 0;
    for (const c of list) {
      const rec = k.byId.get(c.epoch);
      if (!rec) { unknown++; continue; }
      if (await verifyCoupon(rec, c)) good.push(c); else bad++;
    }
    const added = await store.addCoupons(good);
    say('#coupon-msg', `Imported ${added} new coupon${added === 1 ? '' : 's'}.` +
      (good.length - added ? ` ${good.length - added} were already here.` : '') +
      (bad ? ` ${bad} failed signature check and were skipped.` : '') +
      (unknown ? ` ${unknown} use a key this server no longer publishes.` : '') +
      ' Coupons already spent elsewhere will be dropped the first time the server rejects them.');
    if (added) store.requestPersistence();
  } catch (err) {
    say('#coupon-msg', err.code ? humanError(err) : err.message);
  }
});
$('#clear-spent').addEventListener('click', async () => { await store.clearSpent(); say('#coupon-msg', 'Spent receipts cleared.'); });

function say(sel, text) { const n = $(sel); if (n) n.textContent = text; }

// ---------------- buy ----------------
function renderSubtabs() {
  const box = $('#buy-subtabs');
  clear(box);
  const methods = [['eth', 'Buy with ETH']];
  // Burn / Daily are not rendered at all until the token address exists.
  if (state.token?.launched) methods.push(['burn', 'Burn tokens'], ['hold', 'Daily (holders)']);
  if (methods.length === 1) return;
  for (const [m, label] of methods) {
    box.append(el('button', {
      class: 'btn sm' + (state.method === m ? '' : ' ghost'), type: 'button', 'aria-pressed': String(state.method === m), text: label,
      onclick: () => { state.method = m; renderSubtabs(); renderBuyForm(); resetProgress(); },
    }));
  }
}

function selectedWei() {
  if (state.customEth) { try { return parseEth(state.customEth); } catch { return null; } }
  return BigInt(state.presetWei);
}

function renderBuyForm() {
  const box = $('#buy-form');
  if (!box || state.busy) return;
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // don't wipe typing
  clear(box);
  const s = state.status;
  if (!s) {
    box.append(el('p', { class: 'notice warn', text: 'Could not load prices from the server. ' }),
      el('button', { class: 'btn ghost sm', type: 'button', text: 'Try again', onclick: refreshStatus }));
    return;
  }
  if (state.method === 'eth') return renderEthForm(box, s);
  if (state.method === 'burn') return renderBurnForm(box, s);
  if (state.method === 'hold') return renderHoldForm(box, s);
}

function renderEthForm(box, s) {
  const price = BigInt(s.priceWei);
  box.append(el('h2', { text: 'Buy coupons with ETH' }),
    el('p', { class: 'small muted', text: `${formatEth(price)} ETH per coupon · Robinhood Chain (4663) · up to ${fmtInt(s.maxPack)} per payment` }));
  const presets = el('div', { class: 'presets', role: 'group', 'aria-label': 'Pack size' });
  for (const w of PRESETS) {
    const n = BigInt(w) / price;
    presets.append(el('button', {
      class: 'preset', type: 'button', 'aria-pressed': String(!state.customEth && state.presetWei === w),
      onclick: () => { state.presetWei = w; state.customEth = ''; renderBuyForm(); },
    }, el('span', { class: 'cn' }, fmtInt(Number(n > BigInt(s.maxPack) ? BigInt(s.maxPack) : n)), ' ', el('small', { text: 'coupons' })),
    el('span', { class: 'eth', text: `${formatEth(w)} ETH` })));
  }
  const input = el('input', { id: 'custom-eth', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 0.001', value: state.customEth });
  input.addEventListener('input', () => { state.customEth = input.value.trim(); updateSummary(); for (const b of presets.children) b.setAttribute('aria-pressed', String(!state.customEth && state.presetWei === b.dataset.w)); });
  for (const [i, b] of [...presets.children].entries()) b.dataset.w = PRESETS[i];
  const summary = el('div', { class: 'summary' });
  const btn = el('button', { class: 'btn red', type: 'button', text: wallet.hasWallet() ? 'Connect wallet & pay' : 'Connect wallet & pay', onclick: () => buyEth() });
  box.append(presets, el('div', { class: 'field' }, el('label', { for: 'custom-eth', text: 'Or any amount (ETH)' }), input), summary, btn);
  if (!wallet.hasWallet()) box.append(el('p', { class: 'notice small', text: humanError(new ClientError('no_wallet')) }));

  function updateSummary() {
    clear(summary);
    const wei = selectedWei();
    if (wei === null) { summary.append(el('span', { text: 'Enter an amount like 0.002.' })); btn.disabled = true; return; }
    let n = wei / price;
    const max = BigInt(s.maxPack);
    btn.disabled = n < 1n;
    if (n < 1n) { summary.append(el('span', { text: `Minimum is ${formatEth(price)} ETH (1 coupon).` })); return; }
    let note = '';
    if (n > max) { note = `Capped at ${fmtInt(s.maxPack)} coupons per payment — ${formatEth(max * price)} ETH will be sent.`; n = max; }
    const value = n * price;
    const rest = wei - value;
    if (!note && rest > 0n) note = `${formatEth(rest)} ETH doesn’t make a full coupon, so only ${formatEth(value)} ETH will be sent.`;
    summary.append(
      el('div', { class: 'line' }, el('span', { text: 'You get' }), el('b', { text: `${fmtInt(Number(n))} coupons` })),
      el('div', { class: 'line' }, el('span', { text: 'You pay' }), el('b', { text: `${formatEth(value)} ETH + gas` })),
      el('div', { class: 'line' }, el('span', { text: 'Messages' }), el('b', { text: `${fmtInt(Number(n))} fast or ${fmtInt(Number(n / 3n))} deep` })));
    if (note) summary.append(el('div', { class: 'small red', text: note }));
  }
  updateSummary();
}

function renderBurnForm(box, s) {
  const per = s.token?.tokensPerCoupon;
  box.append(el('h2', { text: 'Burn tokens for coupons' }));
  if (!per) { box.append(el('p', { class: 'notice', text: 'The burn rate is not set on the server yet. Buying with ETH works.' })); return; }
  const sym = state.token.symbol ? '$' + String(state.token.symbol).replace(/^\$/, '') : 'tokens';
  box.append(el('p', { class: 'small muted', text: `${fmtInt(per)} ${sym} burned = 1 coupon. Tokens go to the dead address (0x…dEaD), on chain, for good.` }));
  const input = el('input', { id: 'burn-n', inputmode: 'numeric', autocomplete: 'off', value: '25' });
  const summary = el('div', { class: 'summary' });
  const upd = () => {
    const n = Math.min(Math.max(parseInt(input.value, 10) || 0, 0), s.maxPack);
    clear(summary).append(el('div', { class: 'line' }, el('span', { text: 'You burn' }), el('b', { text: `${(BigInt(per) * BigInt(n)).toLocaleString('en-US')} ${sym}` })),
      el('div', { class: 'line' }, el('span', { text: 'You get' }), el('b', { text: `${fmtInt(n)} coupons` })));
  };
  input.addEventListener('input', upd);
  upd();
  box.append(el('div', { class: 'field' }, el('label', { for: 'burn-n', text: `Coupons (1–${s.maxPack})` }), input), summary,
    el('button', { class: 'btn red', type: 'button', text: 'Connect wallet & burn', onclick: () => buyBurn(Math.min(Math.max(parseInt(input.value, 10) || 0, 0), s.maxPack)) }));
}

function renderHoldForm(box, s) {
  box.append(el('h2', { text: 'Daily coupons for holders' }));
  if (!s.token?.holdMin) { box.append(el('p', { class: 'notice', text: 'The holder minimum is not set on the server yet.' })); return; }
  box.append(el('p', { class: 'small muted', text: `Hold at least ${fmtInt(s.token.holdMin)} tokens and claim ${fmtInt(s.holdPerDay)} coupons once per UTC day (today: ${utcDay()}). You only sign a message — no transaction, no gas.` }),
    el('button', { class: 'btn red', type: 'button', text: `Connect wallet & claim ${s.holdPerDay}`, onclick: () => claimHold() }));
}

// ---------------- progress ----------------
const STEPS = {
  eth: ['Connect wallet', 'Switch to Robinhood Chain', 'Check balance', 'Prepare blind coupons', 'Send payment', 'Sign the claim', 'Wait for confirmation', 'Receive & verify signatures'],
  burn: ['Connect wallet', 'Switch to Robinhood Chain', 'Check token balance', 'Prepare blind coupons', 'Send burn', 'Sign the claim', 'Wait for confirmation', 'Receive & verify signatures'],
  hold: ['Connect wallet', 'Switch to Robinhood Chain', 'Prepare blind coupons', 'Sign the daily claim', 'Receive & verify signatures'],
};
let stepIdx = -1;
function resetProgress(kind = state.method) {
  const ol = $('#progress');
  clear(ol);
  for (const s of STEPS[kind]) ol.append(el('li', { text: s }));
  stepIdx = -1;
  clear($('#buy-result'));
}
function step(i, extra) {
  const lis = $$('#progress li');
  lis.forEach((li, j) => { li.className = j < i ? 'done' : j === i ? 'doing' : ''; });
  if (extra && lis[i]) lis[i].textContent = STEPS[state.method]?.[i] ? `${STEPS[state.method][i]} — ${extra}` : extra;
  stepIdx = i;
}
function stepFail() {
  const lis = $$('#progress li');
  if (lis[stepIdx]) lis[stepIdx].className = 'fail';
}
function stepAllDone() { for (const li of $$('#progress li')) li.className = 'done'; }
function result(nodes, warn = false) {
  const box = clear($('#buy-result'));
  box.append(el('div', { class: 'notice' + (warn ? ' warn' : ''), role: warn ? 'alert' : 'status' }, ...nodes));
}

// ---------------- purchase flows ----------------
async function begin(kind) {
  if (state.busy) return null;
  state.busy = true;
  state.method = kind;
  resetProgress(kind);
  step(0);
  const address = await wallet.connect();
  step(1);
  await wallet.ensureChain(state.status?.explorer);
  return address;
}

async function buyEth() {
  const s = state.status;
  try {
    const price = BigInt(s.priceWei);
    const wei = selectedWei();
    if (wei === null) throw new ClientError('bad_amount', 'Enter an amount like 0.002.');
    let n = wei / price;
    if (n > BigInt(s.maxPack)) n = BigInt(s.maxPack);
    if (n < 1n) throw new ClientError('bad_amount', `Minimum is ${formatEth(price)} ETH.`);
    const value = n * price;
    const k = await ensureKeys().catch(() => { throw new ClientError('key_unavailable'); });
    const keyRec = k.byId.get(k.current);
    if (!keyRec) throw new ClientError('key_unavailable');

    const address = await begin('eth');
    step(2);
    await wallet.checkFunds(address, value);
    step(3, `${n} coupons`);
    const batch = await makeBatch(keyRec, Number(n));
    const p = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: 'eth', keyId: keyRec.id, address, count: Number(n), valueWei: value.toString(),
      msgs: batch.msgs, inv: batch.inv, blinded: batch.blinded, batchHash: batch.batchHash,
      txHash: null, sig: null, stage: 'blinded', createdAt: Date.now(),
    };
    // Must be saved BEFORE the transaction, so a reload can still claim.
    await store.savePending(p).catch(() => { throw new ClientError('storage_failed'); });
    step(4, `${formatEth(value)} ETH`);
    try {
      p.txHash = await wallet.sendEth({ from: address, to: s.treasury, valueWei: value });
    } catch (e) {
      await store.deletePending(p.id); // nothing was sent
      throw e;
    }
    p.stage = 'sent';
    await store.savePending(p);
    await signAndClaim(p);
  } catch (e) {
    failed(e);
  } finally {
    state.busy = false;
    renderPending();
  }
}

async function buyBurn(n) {
  const s = state.status;
  try {
    if (!n || n < 1) throw new ClientError('bad_amount', 'Pick at least 1 coupon.');
    const per = BigInt(s.token.tokensPerCoupon);
    const tokenAddr = state.token.address;
    const k = await ensureKeys().catch(() => { throw new ClientError('key_unavailable'); });
    const keyRec = k.byId.get(k.current);
    const address = await begin('burn');
    step(2);
    let dec = 18n;
    try {
      const raw = await wallet.provider().request({ method: 'eth_call', params: [{ to: tokenAddr, data: '0x313ce567' }, 'latest'] });
      dec = BigInt(raw);
    } catch { /* default 18 */ }
    const amount = per * BigInt(n) * 10n ** dec;
    const bal = await wallet.tokenBalance(tokenAddr, address);
    if (bal < amount) throw new ClientError('insufficient_tokens', `This wallet holds fewer tokens than needed (${(per * BigInt(n)).toLocaleString('en-US')}).`);
    await wallet.checkFunds(address, 0n, 80000n);
    step(3, `${n} coupons`);
    const batch = await makeBatch(keyRec, n);
    const p = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: 'burn', keyId: keyRec.id, address, count: n, amount: amount.toString(),
      msgs: batch.msgs, inv: batch.inv, blinded: batch.blinded, batchHash: batch.batchHash,
      txHash: null, sig: null, stage: 'blinded', createdAt: Date.now(),
    };
    await store.savePending(p).catch(() => { throw new ClientError('storage_failed'); });
    step(4);
    try {
      p.txHash = await wallet.sendBurn({ from: address, token: tokenAddr, amountUnits: amount });
    } catch (e) { await store.deletePending(p.id); throw e; }
    p.stage = 'sent';
    await store.savePending(p);
    await signAndClaim(p);
  } catch (e) {
    failed(e);
  } finally {
    state.busy = false;
    renderPending();
  }
}

async function claimHold() {
  const s = state.status;
  try {
    const k = await ensureKeys().catch(() => { throw new ClientError('key_unavailable'); });
    const keyRec = k.byId.get(k.current);
    const address = await begin('hold');
    step(2);
    const day = utcDay();
    const batch = await makeBatch(keyRec, Number(s.holdPerDay));
    const p = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: 'hold', keyId: keyRec.id, address, day, count: Number(s.holdPerDay),
      msgs: batch.msgs, inv: batch.inv, blinded: batch.blinded, batchHash: batch.batchHash,
      sig: null, stage: 'blinded', createdAt: Date.now(),
    };
    await store.savePending(p).catch(() => { throw new ClientError('storage_failed'); });
    step(3);
    p.sig = await wallet.personalSign(address, wallet.holdMessage({ address, day, batchHash: p.batchHash, count: p.count }));
    p.stage = 'signed';
    await store.savePending(p);
    step(4);
    await claimLoop(p, 4);
  } catch (e) {
    failed(e);
  } finally {
    state.busy = false;
    renderPending();
  }
}

/** Sign the issue message (if not yet) and claim. */
async function signAndClaim(p, opts = {}) {
  activePending = p.id;
  if (!p.sig) {
    step(5);
    let address = p.address;
    if (opts.reconnect) {
      address = await wallet.connect();
      if (address !== p.address) throw new ClientError('wrong_account', `Switch your wallet to ${shortHex(p.address)} — the account that paid — and try again.`);
    }
    p.sig = await wallet.personalSign(address, wallet.issueMessage({ txHash: p.txHash, batchHash: p.batchHash, count: p.count }));
    p.stage = 'signed';
    await store.savePending(p);
  }
  step(6, 'usually a few seconds');
  await claimLoop(p, 7);
}

let claimAbort = null;
let activePending = null;
async function claimLoop(p, verifyStep) {
  activePending = p.id;
  const started = Date.now();
  claimAbort = new AbortController();
  while (true) {
    try {
      const res = p.kind === 'hold'
        ? await postHoldClaim({ address: p.address, day: p.day, blinded: p.blinded, sig: p.sig }, claimAbort.signal)
        : await postIssue({ address: p.address, txHash: p.txHash, blinded: p.blinded, sig: p.sig }, claimAbort.signal);
      step(verifyStep);
      const k = await ensureKeys();
      const keyRec = k.byId.get(res.keyId || p.keyId);
      if (!keyRec) throw new ClientError('key_unavailable');
      const coupons = await finalizeBatch(keyRec, p.msgs, p.inv, res.blindSigs);
      await store.addCoupons(coupons);
      await store.deletePending(p.id);
      store.requestPersistence();
      activePending = null;
      stepAllDone();
      const until = keyRec.redeemUntil ? fmtDate(keyRec.redeemUntil) : 'the key’s end date';
      await refreshStatus();
      result([
        el('strong', { text: `${coupons.length} coupons added. ` }),
        `Your wallet is done — it won’t be asked again. Coupons never expire before ${until}. For the best unlinkability, don’t chat right after buying. ${anonNote()}`,
        el('a', { href: '#coupons', text: 'See coupons' }), ' · ', el('a', { href: '#chat', text: 'Start chatting' }),
      ]);
      return;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const retryable = e instanceof ApiError && (e.code === 'tx_not_found' || e.code === 'rpc_unavailable' || e.code === 'network' || e.code === 'rate_limited' || e.status >= 500);
      if (retryable && Date.now() - started < CLAIM_TIMEOUT_MS) {
        step(stepIdx, humanError(e).split('.')[0]);
        await sleep(e.code === 'rate_limited' ? 10000 : CLAIM_RETRY_MS);
        continue;
      }
      if (retryable) throw new ClientError('claim_timeout');
      throw e;
    }
  }
}

function anonNote() {
  const s = state.status;
  if (!s) return '';
  const n = s.issuedByKey?.[s.keyId] ?? s.issued;
  return `(Coupons issued with key ${s.keyId} so far: ${fmtInt(n)}.) `;
}

function failed(e) {
  stepFail();
  const paid = activePending !== null;
  activePending = null;
  const msg = paid && e?.code === 'user_rejected'
    ? 'The claim was not signed. Your payment went through and this purchase is saved here — press Retry claim when ready.'
    : humanError(e) + (paid && e?.code !== 'verify_failed' ? ' The purchase is saved here; use Retry claim.' : '');
  const nodes = [el('strong', { text: 'Not done. ' }), msg];
  if (e?.code === 'insufficient_funds') nodes.push(' Bridge or send ETH to this wallet on Robinhood Chain first.');
  result(nodes, true);
}

// ---------------- pending purchases ----------------
async function renderPending() {
  const box = $('#pending-list');
  if (!box) return;
  const list = await store.listPending();
  clear(box);
  for (const p of list) {
    if (state.busy && p.id === activePending) continue;
    const card = el('div', { class: 'pending-card' });
    const what = p.kind === 'hold' ? `Daily claim (${p.day})` : p.kind === 'burn' ? `Burn for ${p.count} coupons` : `${p.count} coupons for ${formatEth(p.valueWei)} ETH`;
    card.append(el('strong', { text: 'Unfinished purchase: ' }), what, el('br'),
      el('span', { class: 'small muted', text: `Started ${fmtDateTime(p.createdAt)} · wallet ${shortHex(p.address)}${p.txHash ? ' · tx ' + shortHex(p.txHash, 10, 6) : ''}` }));
    const btns = el('div', { class: 'row-btns' });
    if (p.kind !== 'hold' && !p.txHash) {
      card.append(el('p', { class: 'small', text: 'This browser never saw a transaction hash. If your wallet did send the payment, paste its hash here to claim; otherwise discard.' }));
      const input = el('input', { placeholder: '0x… transaction hash', autocomplete: 'off', 'aria-label': 'Transaction hash' });
      btns.append(el('div', { class: 'field' }, input), el('button', {
        class: 'btn sm', type: 'button', text: 'Claim with this hash',
        onclick: async () => {
          const h = input.value.trim().toLowerCase();
          if (!/^0x[0-9a-f]{64}$/.test(h) && !/^0xmock/.test(h)) { result(['That doesn’t look like a transaction hash (0x + 64 hex characters).'], true); return; }
          p.txHash = h; p.stage = 'sent'; await store.savePending(p); retryPending(p);
        },
      }));
    } else {
      btns.append(el('button', { class: 'btn sm red', type: 'button', text: 'Retry claim', onclick: () => retryPending(p) }));
    }
    btns.append(el('button', {
      class: 'linkbtn small', type: 'button', text: 'Discard',
      onclick: async () => {
        if (p.txHash && !confirm('Discard this purchase? If the payment went through, its coupons can no longer be claimed from this browser.')) return;
        await store.deletePending(p.id);
      },
    }));
    card.append(btns);
    box.append(card);
  }
}

async function retryPending(p) {
  if (state.busy) return;
  state.busy = true;
  state.method = p.kind;
  resetProgress(p.kind);
  try {
    if (p.kind === 'hold') {
      if (!p.sig) {
        step(0); const a = await wallet.connect();
        if (a !== p.address) throw new ClientError('wrong_account', `Switch your wallet to ${shortHex(p.address)} and try again.`);
        step(3);
        p.sig = await wallet.personalSign(a, wallet.holdMessage({ address: a, day: p.day, batchHash: p.batchHash, count: p.count }));
        await store.savePending(p);
      }
      step(4);
      await claimLoop(p, 4);
    } else {
      for (let i = 0; i < 5; i++) step(i);
      await signAndClaim(p, { reconnect: !p.sig });
    }
  } catch (e) {
    failed(e);
  } finally {
    state.busy = false;
    renderPending();
    renderBuyForm();
  }
}

// ---------------- forget ----------------
function renderForget() {
  $('[data-current-booth]').textContent = chat.boothId ? '' : '(No booth is open right now.)';
  $('#forget-booth').disabled = !chat.boothId;
}
$('#forget-booth').addEventListener('click', async () => {
  const id = chat.boothId;
  if (!id) return;
  if (!confirm('Forget this booth? The conversation is deleted from this browser.')) return;
  await store.deleteBooth(id);
  chat.load(null);
  renderBoothList();
  renderForget();
  say('#forget-msg', 'Booth forgotten.');
});
$('#forget-all').addEventListener('click', async () => {
  const usable = await store.countUsable(null);
  const pend = (await store.listPending()).length;
  const warn = `Forget everything? This deletes all conversations${usable ? `, ${usable} unspent coupon${usable === 1 ? '' : 's'}` : ''}${pend ? `, and ${pend} unfinished purchase${pend === 1 ? '' : 's'}` : ''} from this browser. Export first if you want to keep the coupons.`;
  if (!confirm(warn)) return;
  await store.forgetEverything();
  chat.load(null);
  renderBoothList();
  renderCoupons();
  renderForget();
  say('#forget-msg', 'Everything in this browser was forgotten.');
});

// ---------------- boot ----------------
(async function boot() {
  const mode = await store.storageMode();
  if (mode !== 'indexeddb') {
    banner('storage', [el('strong', { text: 'Coupons live in this browser only. ' }), 'Export them, or they vanish with this tab. (This browser blocks storage — private mode?)']);
  }
  await store.recoverInflight();
  state.token = await tokenReady;
  renderSubtabs();
  showTab();
  renderBoothList();
  const latest = (await store.listBooths())[0];
  if (latest) chat.load(latest);
  ensureKeys().catch(() => banner('keys', 'Could not load the signing key — coupons can’t be checked right now. Retrying when you buy.'));
  await refreshStatus();
  renderCoupons();
  renderPending();
  if ((await store.listPending()).length && location.hash !== '#buy') {
    banner('pending', [el('strong', { text: 'You have an unfinished purchase. ' }), el('a', { href: '#buy', text: 'Finish claiming it →' })]);
  }
  store.onChange((d) => {
    if (d.store === 'pending') store.listPending().then((l) => { const b = document.getElementById('banner-pending'); if (b && !l.length) b.remove(); });
  });
  wallet.onAccountsChanged(() => { if (!state.busy) renderBuyForm(); });
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 60000);
})();
