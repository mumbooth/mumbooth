// Shared chat component: hero trial box on "/" and the main chat in /booth.
// Model output is rendered with textContent only (a tiny safe subset: paragraphs, `code`, ``` blocks, **bold**).

import { chatStream } from './api.js';
import { humanError, ClientError } from './errors.js';
import { el, clear } from './util.js';
import * as store from './coupons.js';

export const LIMITS = {
  trial: { maxMsgs: 6, maxChars: 6000, perMsg: 6000 },
  fast: { maxMsgs: 40, maxChars: 24000, perMsg: 8000 },
  deep: { maxMsgs: 40, maxChars: 48000, perMsg: 8000 },
};
export const COST = { fast: 1, deep: 3 };
export const MODEL_LABEL = { fast: 'Claude Haiku 5.5', deep: 'Claude Sonnet 5.5' };

const TRIAL_PROMPTS = [
  'What do you know about me right now?',
  'Explain blind signatures like I’m twelve.',
  'Write a two-line note declining a meeting.',
];

/** Render model text safely into `node`. */
export function renderRich(node, text) {
  clear(node);
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // fenced code: drop an optional language tag on the first line
      const body = part.replace(/^[\w+-]*\n/, '');
      node.append(el('pre', {}, el('code', { text: body.replace(/\n$/, '') })));
      return;
    }
    const paras = part.split(/\n{2,}/);
    for (const para of paras) {
      if (!para.trim()) continue;
      node.append(inline(el('p'), para.replace(/^\n+|\n+$/g, '')));
    }
  });
}
function inline(p, text) {
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) p.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('`')) p.append(el('code', { text: tok.slice(1, -1) }));
    else p.append(el('strong', { text: tok.slice(2, -2) }));
    last = m.index + tok.length;
  }
  if (last < text.length) p.append(document.createTextNode(text.slice(last)));
  return p;
}

/**
 * Normalise history into a valid alternating context ending with the newest user message,
 * within the count/char limits. Returns {messages, trimmed}.
 */
export function buildContext(history, limits) {
  const seq = [];
  for (const m of history) {
    if (!m || !m.content || !m.content.trim()) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const last = seq[seq.length - 1];
    if (last && last.role === m.role) {
      if (m.role === 'user') seq[seq.length - 1] = { role: 'user', content: m.content }; // unanswered question replaced
      else last.content += '\n\n' + m.content;
    } else {
      seq.push({ role: m.role, content: m.content });
    }
  }
  while (seq.length && seq[0].role !== 'user') seq.shift();
  const original = seq.length;
  const total = () => seq.reduce((n, m) => n + m.content.length, 0);
  while (seq.length > 1 && (seq.length > limits.maxMsgs || total() > limits.maxChars)) {
    seq.splice(0, 2); // drop oldest user+assistant pair
  }
  return { messages: seq, trimmed: seq.length < original };
}

/**
 * createChat(root, opts)
 *  opts.kind: 'trial' (hero) | 'booth'
 *  opts.title: header label
 *  opts.getEpochs: async () => Set of redeemable key ids (booth)
 *  opts.onSaved: (booth) => void (booth)
 *  opts.onSpent: (ids) => void
 */
export function createChat(root, opts = {}) {
  const kind = opts.kind || 'trial';
  let model = 'fast';
  let booth = null;            // {id,title,createdAt,messages}
  let history = [];            // [{role, content, note?, cost?}]
  let busy = false;
  let controller = null;
  let usable = 0;

  // ---- DOM ----
  const meta = el('span', { class: 'meta' });
  const top = el('div', { class: 'chat-top' },
    el('span', {}, el('span', { class: 'dot', 'aria-hidden': 'true' }), opts.title || 'Booth'),
    meta);
  const log = el('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text' });
  const alertBox = el('div', { class: 'chat-alert notice warn', role: 'alert', hidden: true });
  const ta = el('textarea', {
    rows: '2', placeholder: kind === 'trial' ? 'Type a message — no wallet, no sign-up' : 'Type a message',
    'aria-label': 'Message', enterkeyhint: 'send', autocomplete: 'off', autocorrect: 'on', spellcheck: 'true',
  });
  const sendBtn = el('button', { class: 'btn red', type: 'submit', text: 'Send' });
  const form = el('form', { class: 'chat-form' }, ta, sendBtn);
  const barLeft = el('div', { class: 'left' });
  const barRight = el('div', { class: 'right' });
  const bar = el('div', { class: 'chat-bar' }, barLeft, barRight);

  const chat = el('div', { class: 'chat' + (kind === 'booth' ? ' tall' : '') }, top, log, alertBox, form, bar);
  root.append(chat);

  // model selector (booth only)
  let seg = null;
  if (kind === 'booth') {
    seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Model' });
    for (const m of ['fast', 'deep']) {
      seg.append(el('button', {
        type: 'button', 'aria-pressed': String(m === model), dataset: { model: m }, title: MODEL_LABEL[m],
        onclick: () => { model = m; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.model === m)); refreshBar(); },
      }, m, el('span', { class: 'c', text: `${COST[m]} coupon${COST[m] > 1 ? 's' : ''}` })));
    }
    barLeft.append(seg);
  }
  const barInfo = el('span');
  barLeft.append(barInfo);

  function refreshBar() {
    if (kind === 'trial') {
      meta.textContent = `${MODEL_LABEL.fast} · 3 free messages a day per network`;
      barInfo.textContent = 'Trial chats are not saved anywhere, not even here.';
      clear(barRight).append(el('a', { href: '/booth/#buy', text: 'Get coupons →' }));
      return;
    }
    const mode = currentMode();
    if (mode === 'trial') {
      meta.textContent = `no coupons · free trial (${MODEL_LABEL.fast}, 3/day per network)`;
      barInfo.textContent = '';
      if (seg) seg.hidden = true;
    } else {
      meta.textContent = `${usable} coupon${usable === 1 ? '' : 's'} left · ${MODEL_LABEL[model]} = ${COST[model]} per message`;
      barInfo.textContent = '';
      if (seg) seg.hidden = false;
    }
    clear(barRight).append(el('span', { text: 'History stays in this browser.' }));
  }

  function currentMode() {
    if (kind === 'trial') return 'trial';
    return usable > 0 ? 'coupon' : 'trial';
  }

  async function refreshUsable() {
    if (kind !== 'booth') return;
    try {
      const epochs = opts.getEpochs ? await opts.getEpochs() : null;
      usable = await store.countUsable(epochs);
    } catch { usable = 0; }
    refreshBar();
  }

  // ---- rendering ----
  function emptyState() {
    const wrap = el('div', { class: 'chat-empty' });
    if (kind === 'trial') {
      wrap.append(el('span', { class: 'big', text: 'Step inside. Say anything.' }),
        el('span', { text: 'No wallet needed for the first three messages today.' }));
    } else {
      wrap.append(el('span', { class: 'big', text: 'New booth.' }),
        el('span', { text: 'Each message costs coupons, not an account. This conversation is kept only in this browser.' }));
    }
    const ul = el('ul');
    for (const p of TRIAL_PROMPTS) {
      ul.append(el('li', {}, el('button', { type: 'button', text: p, onclick: () => { ta.value = p; send(); } })));
    }
    wrap.append(ul);
    return wrap;
  }

  function msgNode(m) {
    const body = el('div', { class: 'body' });
    if (m.role === 'assistant') renderRich(body, m.content);
    else body.textContent = m.content;
    const node = el('div', { class: `msg ${m.role}` },
      el('span', { class: 'who', text: m.role === 'user' ? 'You' : 'Booth' }), body);
    if (m.note) node.append(el('span', { class: 'note', text: m.note }));
    if (m.cost) node.append(el('span', { class: 'cost', text: m.cost }));
    return node;
  }

  function renderAll() {
    clear(log);
    if (!history.length) log.append(emptyState());
    for (const m of history) log.append(msgNode(m));
    scrollDown();
  }
  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function showAlert(text, link) {
    clear(alertBox);
    alertBox.append(document.createTextNode(text));
    if (link) alertBox.append(' ', el('a', { href: link.href, text: link.text }));
    alertBox.hidden = false;
  }
  function hideAlert() { alertBox.hidden = true; clear(alertBox); }

  function setBusy(b) {
    busy = b;
    ta.readOnly = false;
    sendBtn.textContent = b ? 'Stop' : 'Send';
    sendBtn.classList.toggle('red', !b);
    sendBtn.setAttribute('aria-label', b ? 'Stop the answer' : 'Send message');
  }

  // ---- send ----
  form.addEventListener('submit', (e) => { e.preventDefault(); if (busy) controller?.abort(); else send(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  });

  async function send() {
    const text = ta.value.trim();
    if (!text) { ta.focus(); showAlert('Type a message first.'); return; }
    const mode = currentMode();
    const lim = mode === 'trial' ? LIMITS.trial : LIMITS[model];
    if (text.length > lim.perMsg) { showAlert(`That message is ${text.length.toLocaleString('en-US')} characters; the limit here is ${lim.perMsg.toLocaleString('en-US')}.`); return; }
    hideAlert();

    if (kind === 'booth' && !booth) booth = { id: newId(), title: '', createdAt: Date.now(), messages: [] };
    const userMsg = { role: 'user', content: text };
    history.push(userMsg);
    if (log.querySelector('.chat-empty')) clear(log);
    log.append(msgNode(userMsg));
    ta.value = '';
    ta.style.height = '';
    scrollDown();

    const { messages, trimmed } = buildContext(history, lim);
    const answer = { role: 'assistant', content: '' };
    const aNode = msgNode(answer);
    const aBody = aNode.querySelector('.body');
    aBody.classList.add('cursor');
    log.append(aNode);
    scrollDown();

    controller = new AbortController();
    setBusy(true);
    let metaSeen = false;
    let picked = null;
    let failed = null;
    let cutShort = false;
    let raf = 0;
    const paint = () => { raf = 0; renderRich(aBody, answer.content); scrollDown(); };

    const attempt = async () => {
      let req;
      if (mode === 'coupon') {
        const need = COST[model];
        const epochs = opts.getEpochs ? await opts.getEpochs() : null;
        picked = await store.takeCoupons(need, epochs);
        if (!picked) throw new ClientError('coupons_required', undefined, { need, got: await store.countUsable(epochs) });
        req = { mode: 'coupon', model, coupons: picked.map(({ epoch, msg, sig }) => ({ epoch, msg, sig })), messages };
      } else {
        req = { mode: 'trial', model: 'fast', messages };
      }
      for await (const ev of chatStream(req, controller.signal)) {
        if (ev.event === 'meta') {
          metaSeen = true;
          if (picked) {
            const ids = picked.map((c) => c.id);
            await store.markSpent(ids);
            opts.onSpent?.(ids);
            answer.cost = `${ev.data.couponsSpent ?? ids.length} coupon${(ev.data.couponsSpent ?? ids.length) === 1 ? '' : 's'} spent · ${MODEL_LABEL[model]}`;
          } else {
            answer.cost = `free trial · ${MODEL_LABEL.fast}`;
          }
        } else if (ev.event === 'delta') {
          answer.content += ev.data.text || '';
          if (!raf) raf = requestAnimationFrame(paint);
        } else if (ev.event === 'error') {
          cutShort = true;
          const err = new ClientError(ev.data.code || 'model_error');
          err.spent = !!ev.data.spent;
          throw err;
        } else if (ev.event === 'done') {
          break;
        }
      }
    };

    let retried = false;
    while (true) {
      try {
        await attempt();
        failed = null;
        break;
      } catch (e) {
        failed = e;
        if (metaSeen || !picked) break;
        // Error before meta: coupons were not charged. Sort out which ones are bad and retry once.
        const idx = Number.isInteger(e.detail?.index) ? e.detail.index : -1;
        const ids = picked.map((c) => c.id);
        const bad = idx >= 0 && idx < picked.length ? picked[idx].id : null;
        if (e.code === 'coupon_spent') {
          if (bad) { await store.markSpent([bad]); await store.releaseCoupons(ids.filter((i) => i !== bad)); }
          else await store.releaseCoupons(ids);
        } else if (e.code === 'coupon_invalid') {
          if (bad) { await store.markInvalid([bad]); await store.releaseCoupons(ids.filter((i) => i !== bad)); }
          else await store.releaseCoupons(ids);
        } else if (e.code === 'key_expired') {
          await store.markExpired(ids);
        } else {
          await store.releaseCoupons(ids);
        }
        picked = null;
        if (!retried && bad && (e.code === 'coupon_spent' || e.code === 'coupon_invalid')) {
          retried = true;
          continue;
        }
        break;
      }
    }
    if (raf) cancelAnimationFrame(raf);
    controller = null;
    setBusy(false);
    aBody.classList.remove('cursor');

    if (failed && !metaSeen && !answer.content) {
      // Nothing was charged: take the message back so it can be resent.
      aNode.remove();
      history.pop();
      log.lastElementChild?.remove();
      if (!history.length) renderAll();
      ta.value = text;
      if (failed.name !== 'AbortError') {
        const code = failed.code;
        const link = code === 'trial_exhausted' || code === 'trial_paused' || code === 'coupons_required'
          ? { href: '/booth/#buy', text: 'Get coupons →' }
          : null;
        const extra = (code === 'coupon_spent' || code === 'coupon_invalid') && retried ? ' Tried the next coupon too — please send again.' : '';
        showAlert(humanError(failed) + extra, link);
      }
    } else {
      if (failed) {
        const charged = metaSeen && mode === 'coupon';
        if (failed.name === 'AbortError') answer.note = charged ? 'Stopped. The coupon was already spent.' : 'Stopped.';
        else if (cutShort || metaSeen) answer.note = charged ? 'Coupon spent, answer cut short.' : 'Answer cut short.';
        else answer.note = humanError(failed);
        if (!answer.content) answer.content = '…';
      }
      if (trimmed) answer.note = (answer.note ? answer.note + ' ' : '') + 'Older messages were left out to fit the context limit.';
      history.push(answer);
      const fresh = msgNode(answer);
      aNode.replaceWith(fresh);
      scrollDown();
      if (kind === 'booth') {
        booth.messages = history;
        if (!booth.title) booth.title = text.slice(0, 48);
        try { await store.saveBooth(booth); opts.onSaved?.(booth); } catch { showAlert(humanError(new ClientError('storage_failed'))); }
      }
    }
    await refreshUsable();
  }

  function newId() {
    const b = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ---- public ----
  const api = {
    load(b) {
      if (busy) controller?.abort();
      booth = b ? { ...b } : null;
      history = b ? [...(b.messages || [])] : [];
      hideAlert();
      renderAll();
      refreshUsable();
    },
    get boothId() { return booth?.id || null; },
    refresh: refreshUsable,
    focus() { ta.focus(); },
    alert: showAlert,
  };

  if (kind === 'booth') store.onChange((d) => { if (!d.store || d.store === 'coupons') refreshUsable(); });
  refreshBar();
  renderAll();
  refreshUsable();
  return api;
}
