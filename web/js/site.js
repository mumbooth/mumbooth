// Shared page chrome driven by /token.json (owned by the lead):
//   [data-ca-text]   contract address (short form)       [data-ca-copy]  copy button
//   [data-ca-note]   shown only while address is zero     [data-symbol]   "$SYM", hidden while null
//   [data-x]         X link, hidden while null            [data-tg]       Telegram link, hidden while null
//   [data-pons]      Buy → Pons button (disabled with a label until set)
//   [data-launched]  only shown once the token address is non-zero
//   [data-prelaunch] only shown while the token address is zero
// Nothing about the token is hard-coded in HTML.

import { getToken } from './api.js';
import { $$, isZeroAddress, shortHex, wireCopyButton } from './util.js';

export const tokenReady = getToken().then((t) => {
  const token = t || {};
  token.launched = !isZeroAddress(token.address);
  return token;
});

function xUrl(x) {
  if (!x) return null;
  if (/^https?:\/\//i.test(x)) return x;
  return 'https://x.com/' + String(x).replace(/^@/, '');
}
function tgUrl(t) {
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  return 'https://t.me/' + String(t).replace(/^@/, '');
}

function apply(token) {
  const addr = token.address || '0x0000000000000000000000000000000000000000';
  for (const n of $$('[data-ca-text]')) {
    n.textContent = token.launched ? shortHex(addr, 8, 6) : '0x000…000';
    n.title = addr;
  }
  for (const n of $$('[data-ca-full]')) n.textContent = addr;
  for (const n of $$('[data-ca-copy]')) {
    if (!n.dataset.wired) { n.dataset.wired = '1'; wireCopyButton(n, () => addr); }
  }
  for (const n of $$('[data-ca-note]')) n.hidden = token.launched;
  for (const n of $$('[data-symbol]')) {
    if (token.symbol) { n.textContent = '$' + String(token.symbol).replace(/^\$/, ''); n.hidden = false; }
    else n.hidden = true;
  }
  const x = xUrl(token.x);
  for (const n of $$('[data-x]')) {
    if (x) { n.href = x; n.hidden = false; n.rel = 'noopener noreferrer'; n.target = '_blank'; }
    else n.hidden = true;
  }
  const tg = tgUrl(token.telegram);
  for (const n of $$('[data-tg]')) {
    if (tg) { n.href = tg; n.hidden = false; n.rel = 'noopener noreferrer'; n.target = '_blank'; }
    else n.hidden = true;
  }
  for (const n of $$('[data-pons]')) {
    if (token.pons) {
      n.href = token.pons;
      n.removeAttribute('aria-disabled');
      n.rel = 'noopener noreferrer';
      n.target = '_blank';
      n.textContent = n.dataset.ponsLabel || 'Buy on Pons →';
    } else {
      n.removeAttribute('href');
      n.setAttribute('aria-disabled', 'true');
      n.textContent = 'Buy on Pons — link at launch';
    }
  }
  for (const n of $$('[data-launched]')) n.hidden = !token.launched;
  for (const n of $$('[data-prelaunch]')) n.hidden = token.launched;
}

tokenReady.then(apply);

// Pons anchors without href must not navigate.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('[data-pons][aria-disabled="true"]');
  if (a) e.preventDefault();
});

// Reveal-on-scroll (decorative). Only below-the-fold blocks are hidden, and only
// when motion is allowed and IntersectionObserver exists; otherwise nothing changes.
// Story pages "turn": the plate swings in from its outer edge, the words follow (CSS).
function setupReveal() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const targets = $$('.page > .plate, .page > .words, .chapter > h2, .chapter > .ledger-card, .cards > .card, '
    + '.sec > .sec-head, .sec > .doc, .sec > .ledger, .sec > .table-scroll, .sec > .tally, .foot');
  const below = targets.filter((n) => n.getBoundingClientRect().top > innerHeight * 0.92);
  if (!below.length) return;
  document.documentElement.classList.add('rv-on');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const n of below) { n.classList.add('rv'); io.observe(n); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupReveal);
else setupReveal();
