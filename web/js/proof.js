// /proof — purchases with explorer links, treasury + dead-address links, live counters.
import { tokenReady } from './site.js';
import { getProof } from './api.js';
import { startLive, onStatus } from './live.js';
import { el, clear, $, fmtInt, fmtDateTime, shortHex, formatEth, DEAD_ADDRESS } from './util.js';
import { DEFAULT_EXPLORER } from './wallet.js';

let explorer = DEFAULT_EXPLORER;

startLive(30000);

onStatus(async (s) => {
  if (!s) return;
  explorer = (s.explorer || DEFAULT_EXPLORER).replace(/\/$/, '');
  const token = await tokenReady;
  const dl = clear($('#links'));
  const link = (href, text) => el('a', { href, rel: 'noopener noreferrer', target: '_blank', text });
  dl.append(el('dt', { text: 'Treasury' }), el('dd', {}, link(`${explorer}/address/${s.treasury}`, s.treasury), ' ↗'));
  dl.append(el('dt', { text: 'Price' }), el('dd', { text: `${formatEth(s.priceWei)} ETH per coupon` }));
  if (token.launched && s.token?.address) {
    dl.append(el('dt', { text: 'Token' }), el('dd', {}, link(`${explorer}/token/${s.token.address}`, s.token.address), ' ↗'));
    dl.append(el('dt', { text: 'Burns' }), el('dd', {}, link(`${explorer}/address/${DEAD_ADDRESS}?tab=tokens`, `${DEAD_ADDRESS} (dead address)`), ' ↗'));
  }
  if (s.rpc === 'down') dl.append(el('dt', { text: 'Chain' }), el('dd', { class: 'red', text: 'chain read failed, retrying' }));
  loadProof();
});

let loading = false;
async function loadProof() {
  if (loading) return;
  loading = true;
  const body = $('#purchases');
  try {
    const p = await getProof();
    clear(body);
    if (!p.purchases?.length) body.append(el('tr', {}, el('td', { colspan: '4', class: 'muted', text: 'No purchases yet.' })));
    for (const x of p.purchases || []) {
      const at = typeof x.at === 'number' ? new Date(x.at) : new Date(x.at);
      body.append(el('tr', {},
        el('td', { text: fmtDateTime(at) }),
        el('td', { text: x.kind === 'burn' ? 'burn' : 'ETH' }),
        el('td', { class: 'num', text: fmtInt(x.n) }),
        el('td', {}, el('a', { href: `${explorer}/tx/${x.txHash}`, rel: 'noopener noreferrer', target: '_blank', text: shortHex(x.txHash, 10, 8) }), ' ↗')));
    }
    const hl = $('#hold-line');
    if (hl && p.holdClaims) hl.textContent = `Holder daily claims: ${fmtInt(p.holdClaims.today)} today, ${fmtInt(p.holdClaims.total)} in total.`;
  } catch {
    clear(body).append(el('tr', {}, el('td', { colspan: '4', class: 'red', text: 'Could not load purchases — retrying.' })));
  } finally {
    loading = false;
  }
}
