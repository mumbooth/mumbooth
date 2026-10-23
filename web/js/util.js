// Small helpers shared by every page. No innerHTML anywhere: all text goes through textContent.

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';

/** Create an element: el('p', {class: 'x', text: 'hi'}, child, 'text'). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function setText(sel, text, root = document) {
  for (const n of $$(sel, root)) n.textContent = text;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---------- bytes ----------
export function b64encode(bytes) {
  let s = '';
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64decode(str) {
  const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function utf8Hex(str) {
  return '0x' + hex(new TextEncoder().encode(str));
}
export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
export function concatBytes(list) {
  const total = list.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

// ---------- numbers ----------
const WEI = 10n ** 18n;

/** wei (string|bigint) -> "0.0005" style string, trimmed. */
export function formatEth(wei, maxDecimals = 6) {
  if (wei === null || wei === undefined || wei === '') return '—';
  let v;
  try { v = BigInt(wei); } catch { return '—'; }
  const neg = v < 0n; if (neg) v = -v;
  const whole = v / WEI;
  let frac = (v % WEI).toString().padStart(18, '0').slice(0, maxDecimals).replace(/0+$/, '');
  if (!frac && whole === 0n && v > 0n) {
    // tiny but non-zero: show more digits instead of 0
    frac = (v % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  }
  return (neg ? '-' : '') + whole.toLocaleString('en-US') + (frac ? '.' + frac : '');
}

/** "0.0005" -> bigint wei. Throws on bad input. */
export function parseEth(str) {
  const s = String(str).trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') throw new Error('Enter an amount like 0.002');
  const [w, f = ''] = s.split('.');
  if (f.length > 18) throw new Error('Too many decimals');
  return BigInt(w || '0') * WEI + BigInt((f + '0'.repeat(18)).slice(0, 18));
}

/** token amount in base units (18 decimals) -> whole-token display. */
export function formatToken(units, decimals = 18) {
  if (units === null || units === undefined) return '—';
  const v = BigInt(units);
  const base = 10n ** BigInt(decimals);
  return (v / base).toLocaleString('en-US');
}

export function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

export function shortHex(h, a = 6, b = 4) {
  if (!h) return '';
  return h.length <= a + b + 1 ? h : `${h.slice(0, a)}…${h.slice(-b)}`;
}

export function fmtDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  return x.toISOString().slice(0, 10);
}
export function fmtDateTime(d) {
  const x = d instanceof Date ? d : new Date(typeof d === 'number' && d < 1e12 ? d * 1000 : d);
  if (Number.isNaN(x.getTime())) return String(d);
  return x.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
export function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function isZeroAddress(a) {
  return !a || /^0x0{40}$/i.test(a);
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

// ---------- copy ----------
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for in-app browsers without the async clipboard API.
    const ta = el('textarea', { 'aria-hidden': 'true', readonly: true });
    ta.value = text;
    ta.className = 'sr-only';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function wireCopyButton(btn, getText) {
  const label = btn.textContent;
  btn.addEventListener('click', async () => {
    const ok = await copyText(getText());
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    btn.classList.toggle('done', ok);
    setTimeout(() => { btn.textContent = label; btn.classList.remove('done'); }, 1400);
  });
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
