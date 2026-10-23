// HTTP client for the MUMBOOTH API (BRIEF §5). Same-origin only; no third parties.
//
// Every non-2xx answer becomes an ApiError carrying the server's {error, message, ...detail}.
// Network failures become ApiError with code "network".

export class ApiError extends Error {
  constructor(status, body) {
    const b = body && typeof body === 'object' ? body : {};
    super(b.message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = b.error || (status === 0 ? 'network' : `http_${status}`);
    this.detail = b;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      cache: 'no-store',
      credentials: 'omit',
      headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, { error: 'network', message: 'Network error' });
  }
  return res;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { error: res.ok ? 'bad_response' : `http_${res.status}`, message: text.slice(0, 200) }; }
}

async function json(path, opts) {
  const res = await request(path, opts);
  const data = await readJson(res);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** GET /api/status */
export const getStatus = (signal) => json('/api/status', { signal });
/** GET /api/keys */
export const getKeys = (signal) => json('/api/keys', { signal });
/** GET /api/proof */
export const getProof = (signal) => json('/api/proof', { signal });
/** POST /api/issue {address, txHash, blinded[], sig} → {keyId, n, blindSigs[]} */
export const postIssue = ({ address, txHash, blinded, sig }, signal) =>
  json('/api/issue', { method: 'POST', body: { address, txHash, blinded, sig }, signal });
/** POST /api/hold/claim {address, day, blinded[], sig} → {keyId, n, blindSigs[]} */
export const postHoldClaim = ({ address, day, blinded, sig }, signal) =>
  json('/api/hold/claim', { method: 'POST', body: { address, day, blinded, sig }, signal });

/** GET /token.json (lead-owned). Falls back to an all-null shape. */
export async function getToken() {
  try {
    const res = await fetch('/token.json', { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error();
    return await res.json();
  } catch {
    return { address: null, symbol: null, chainId: 4663, launch: null, pons: null, x: null, telegram: null };
  }
}

/**
 * POST /api/chat, streamed. The server answers either JSON (error before the stream)
 * or text/event-stream with events meta → delta… → done, or error {code, spent:true}.
 *
 * Async generator yielding {event, data}. Throws ApiError for pre-stream errors.
 */
export async function* chatStream({ mode, model, coupons, messages }, signal) {
  const body = { mode, model, messages };
  if (mode === 'coupon') body.coupons = coupons;
  const res = await request('/api/chat', { method: 'POST', body, signal });
  const ctype = res.headers.get('content-type') || '';
  if (!res.ok || !ctype.includes('text/event-stream')) {
    const data = await readJson(res);
    if (!res.ok) throw new ApiError(res.status, data);
    throw new ApiError(502, { error: 'bad_response', message: 'Unexpected answer from server' });
  }
  if (!res.body) throw new ApiError(502, { error: 'bad_response', message: 'Streaming not supported here' });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw new ApiError(0, { error: 'stream_broken', message: 'Connection dropped' });
      }
      const { value, done } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames end with a blank line. Normalise CRLF.
      buf = buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseFrame(frame);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      const ev = parseFrame(buf.trim());
      if (ev) yield ev;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function parseFrame(frame) {
  let event = 'message';
  const data = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let val = i === -1 ? '' : line.slice(i + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') event = val;
    else if (field === 'data') data.push(val);
  }
  if (!data.length && event === 'message') return null;
  const raw = data.join('\n');
  let parsed = {};
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = { text: raw }; }
  }
  return { event, data: parsed };
}
