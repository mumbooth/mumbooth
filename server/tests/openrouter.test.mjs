import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterModel } from '../model.mjs';

function sseBody(lines) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); },
  });
}

function fakeFetch({ status = 200, lines = [] } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(status === 200 ? sseBody(lines) : 'nope', { status });
  };
  return { fn, calls };
}

const args = { model: 'claude-haiku-5-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 };

test('openrouter: forces ZDR routing, maps model id, sends no user field', async () => {
  const f = fakeFetch({ lines: ['data: [DONE]\n'] });
  const m = createOpenRouterModel({ apiKey: 'k', fetchImpl: f.fn });
  for await (const _ of m.stream(args)) { /* drain */ }
  const b = f.calls[0].body;
  assert.deepEqual(b.provider, { zdr: true, data_collection: 'deny' });
  assert.equal(b.model, 'anthropic/claude-haiku-5.5');
  assert.equal(b.stream, true);
  assert.equal(b.user, undefined);
  assert.deepEqual(b.messages[0], { role: 'system', content: 'sys' });
  assert.deepEqual(Object.keys(f.calls[0].init.headers).sort(), ['Authorization', 'Content-Type']);
});

test('openrouter: parses split SSE chunks, skips keep-alives', async () => {
  const f = fakeFetch({ lines: [
    ': OPENROUTER PROCESSING\n\n',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi',
    'ces":[{"delta":{"content":"lo"}}]}\n\n',
    'data: [DONE]\n\n',
  ] });
  const m = createOpenRouterModel({ apiKey: 'k', fetchImpl: f.fn });
  let out = '';
  for await (const t of m.stream(args)) out += t;
  assert.equal(out, 'Hello');
});

test('openrouter: HTTP error throws before first token with status', async () => {
  const f = fakeFetch({ status: 429 });
  const m = createOpenRouterModel({ apiKey: 'k', fetchImpl: f.fn });
  const it = m.stream(args)[Symbol.asyncIterator]();
  await assert.rejects(it.next(), (e) => e.status === 429);
});

test('openrouter: mid-stream error event throws after text', async () => {
  const f = fakeFetch({ lines: [
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"error":{"code":502,"message":"x"}}\n\n',
  ] });
  const m = createOpenRouterModel({ apiKey: 'k', fetchImpl: f.fn });
  const it = m.stream(args)[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: 'a', done: false });
  await assert.rejects(it.next(), (e) => e.status === 502);
});
