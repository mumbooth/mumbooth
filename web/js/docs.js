// /docs — live key + fingerprint from /api/keys, price + token rules from /api/status.
import { tokenReady } from './site.js';
import { getStatus } from './api.js';
import { loadKeys } from './blind.js';
import { el, clear, $, $$, fmtDate, fmtInt, wireCopyButton } from './util.js';
import { priceLine } from './live.js';

(async () => {
  const box = $('#key-box');
  try {
    const k = await loadKeys();
    clear(box);
    for (const key of k.keys) {
      const fpBtn = el('button', { class: 'copy', type: 'button', text: 'Copy fingerprint' });
      wireCopyButton(fpBtn, () => key.fingerprint);
      const spkiBtn = el('button', { class: 'copy', type: 'button', text: 'Copy SPKI' });
      wireCopyButton(spkiBtn, () => key.spki);
      box.append(
        el('dl', { class: 'kv' },
          el('dt', { text: 'Key id' }), el('dd', {}, el('code', { text: key.id }), key.id === k.current ? ' (current — issues new coupons)' : ' (redeem only)'),
          el('dt', { text: 'Algorithm' }), el('dd', {}, el('code', { text: `${key.alg} · ${key.modulusBits}-bit` })),
          el('dt', { text: 'Issues until' }), el('dd', { text: fmtDate(key.issueUntil) }),
          el('dt', { text: 'Redeem until' }), el('dd', { text: fmtDate(key.redeemUntil) }),
          el('dt', { text: 'Fingerprint' }), el('dd', {}, el('code', { class: 'fp', text: key.fingerprint }),
            key.selfConsistent ? null : el('span', { class: 'red small', text: ' Published fingerprint does not match the key data!' })),
          el('dt', { text: 'SPKI (base64 DER)' }), el('dd', {}, el('pre', { class: 'box spki' }, el('code', { text: key.spki }))),
        ),
        el('div', { class: 'row-btns' }, fpBtn, spkiBtn),
      );
    }
    if (k.changed.length) {
      box.prepend(el('p', { class: 'notice warn', text: `Warning: key ${k.changed.map((c) => c.id).join(', ')} differs from the one this browser saw before.` }));
    }
  } catch {
    clear(box).append(el('p', { class: 'notice warn', text: 'Could not load /api/keys right now. Reload to try again.' }));
  }
})();

(async () => {
  const token = await tokenReady;
  let s;
  try { s = await getStatus(); } catch { return; }
  const line = priceLine(s);
  if (line) for (const n of $$('[data-price-line]')) n.textContent = line;
  if (token.launched && s.token?.tokensPerCoupon) {
    for (const n of $$('[data-burn-rate]')) n.textContent = `Current rate: ${fmtInt(s.token.tokensPerCoupon)} tokens per coupon.`;
  }
  if (token.launched && s.token?.holdMin) {
    for (const n of $$('[data-hold-rule]')) n.textContent = `Current rule: hold ${fmtInt(s.token.holdMin)} tokens → ${fmtInt(s.holdPerDay)} coupons a day.`;
  }
})();
