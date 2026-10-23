// POST /api/chat. Order: validate -> (trial reserve | coupon verify + atomic reserve) -> model -> SSE.
// Reserve-then-refund: the spent rows are written BEFORE the model is called; they are deleted again only if the model fails
// (or the client leaves) before the first token reached the client. After `meta` the spend is final.
import { ApiError, unb64, sha256hex } from './util.mjs';
import { MODELS, TRIAL, LIMITS } from './config.mjs';
import { KLEN, MSG_LEN, verifyCoupon } from './blind.mjs';
import { SYSTEM_PROMPT } from './model.mjs';

const bad = (m = 'Malformed request.') => new ApiError(400, 'bad_request', m);
const BREAKER_FAILS = 5, BREAKER_MS = 60_000;

function validateMessages(messages, trial, maxChars) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > LIMITS.maxMessages) throw bad('messages must be 1..40 items.');
  let total = 0;
  messages.forEach((m, i) => {
    if (!m || typeof m !== 'object' || typeof m.content !== 'string' || m.content.trim().length === 0) throw bad('Each message needs non-empty text content.');
    if (m.role !== (i % 2 === 0 ? 'user' : 'assistant')) throw bad('Roles must alternate, start with user and end with user.');
    if (m.content.length > LIMITS.maxContent) throw new ApiError(400, 'context_too_long', 'A message is too long.', { maxChars: LIMITS.maxContent });
    total += m.content.length;
  });
  if (messages[messages.length - 1].role !== 'user') throw bad('The last message must be from the user.');
  if (total > maxChars || (trial && messages.length > TRIAL.maxMessages)) throw new ApiError(400, 'context_too_long', 'The conversation is too long for this mode.', { maxChars });
}

async function verifyCoupons(ctx, coupons) {
  const out = [];
  for (let i = 0; i < coupons.length; i++) {
    const c = coupons[i];
    const invalid = new ApiError(401, 'coupon_invalid', 'Coupon is not valid.', { index: i });
    if (!c || typeof c.epoch !== 'string') throw invalid;
    const k = ctx.keys.get(c.epoch);
    const msg = unb64(c.msg, MSG_LEN), sig = unb64(c.sig, KLEN);
    if (!k || !msg || !sig) throw invalid;
    if (ctx.now() > Date.parse(k.redeemUntil)) throw new ApiError(410, 'key_expired', 'This coupon\'s key has expired.', { index: i });
    if (!(await verifyCoupon(k.publicKey, msg, sig))) throw invalid;
    out.push({ hash: sha256hex(msg), epoch: k.id });
  }
  return out;
}

function reserveCoupons(ctx, items) {
  ctx.db.tx(() => {
    items.forEach((it, index) => {
      if (ctx.db.get('SELECT 1 AS x FROM spent WHERE hash = ?', it.hash)) throw new ApiError(409, 'coupon_spent', 'Coupon was already used.', { index });
      ctx.db.run('INSERT INTO spent(hash, epoch) VALUES (?, ?)', it.hash, it.epoch);
    });
    ctx.db.run("UPDATE counters SET v = v + ? WHERE k = 'spent_total'", items.length);
  });
}
function refundCoupons(ctx, items) {
  ctx.db.tx(() => {
    let n = 0;
    for (const it of items) n += Number(ctx.db.run('DELETE FROM spent WHERE hash = ?', it.hash).changes);
    ctx.db.run("UPDATE counters SET v = v - ? WHERE k = 'spent_total'", n);
  });
}

function breakerOpen(ctx) {
  const b = ctx.breaker;
  if (b.fails < BREAKER_FAILS) return false;
  if (ctx.now() >= b.openUntil) { b.fails = BREAKER_FAILS - 1; return false; } // half-open: one more failure re-opens
  return true;
}
function breakerNote(ctx, ok) {
  const b = ctx.breaker;
  if (ok) { b.fails = 0; return; }
  b.fails++;
  if (b.fails >= BREAKER_FAILS) b.openUntil = ctx.now() + BREAKER_MS;
}
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export async function chat(ctx, req, reply) {
  const body = req.body;
  if (!body || typeof body !== 'object') throw bad();
  const trialMode = body.mode === 'trial';
  if (!trialMode && body.mode !== 'coupon') throw bad('mode must be "trial" or "coupon".');
  const modelKey = trialMode ? 'fast' : body.model;
  if (modelKey !== 'fast' && modelKey !== 'deep') throw bad('model must be "fast" or "deep".');
  const M = MODELS[modelKey];
  const maxChars = trialMode ? TRIAL.maxChars : M.maxChars;
  const maxTokens = trialMode ? TRIAL.maxTokens : M.maxTokens;
  validateMessages(body.messages, trialMode, maxChars);

  let items = [], trialTok = null;
  if (!trialMode) {
    if (!Array.isArray(body.coupons)) throw bad('coupons must be an array.');
    if (body.coupons.length < M.coupons) throw new ApiError(402, 'coupons_required', `This model needs ${M.coupons} coupon(s).`, { need: M.coupons, got: body.coupons.length });
    if (body.coupons.length > M.coupons) throw bad(`Send exactly ${M.coupons} coupon(s).`);
  }
  if (breakerOpen(ctx)) throw new ApiError(503, 'model_unavailable', 'The model is temporarily unavailable. No coupon was spent.');
  if (trialMode) trialTok = ctx.trial.reserve(req.ip);
  else {
    items = await verifyCoupons(ctx, body.coupons);
    reserveCoupons(ctx, items);
  }
  const refund = () => { if (trialMode) ctx.trial.refund(trialTok); else refundCoupons(ctx, items); };

  const res = reply.raw;
  const ac = new AbortController();
  let sent = false, finished = false;
  res.on('close', () => { if (!finished) ac.abort(); });
  const system = SYSTEM_PROMPT;
  try {
    const gen = ctx.model.stream({ model: M.id, system, messages: body.messages.map((m) => ({ role: m.role, content: m.content })), maxTokens, effort: M.effort, signal: ac.signal });
    for await (const text of gen) {
      if (ac.signal.aborted) break;
      if (!text) continue;
      if (!sent) {
        sent = true;
        reply.hijack();
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        sse(res, 'meta', { model: M.id, couponsSpent: trialMode ? 0 : M.coupons });
        breakerNote(ctx, true);
      }
      sse(res, 'delta', { text });
    }
    if (ac.signal.aborted) { if (!sent) { refund(); reply.hijack(); } finished = true; return; }
    if (!sent) throw Object.assign(new Error('empty'), { empty: true });
    sse(res, 'done', {});
    finished = true; res.end();
  } catch (e) {
    if (ac.signal.aborted) { if (!sent) { refund(); reply.hijack(); } finished = true; return; }
    if (!e?.refusal) breakerNote(ctx, false);
    ctx.logEvent('model_error', { status: e?.status ?? null, type: e?.error?.error?.type ?? e?.error?.type ?? null });
    if (!sent) { refund(); finished = true; throw new ApiError(503, 'model_unavailable', 'The model could not answer. No coupon was spent.'); }
    try { sse(res, 'error', { code: 'model_error', spent: true }); } catch {}
    finished = true; res.end();
  }
}
