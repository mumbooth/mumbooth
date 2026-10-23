// Model backends. Contract: stream({model, system, messages, maxTokens, effort, signal}) -> async iterable of text chunks.
// A throw before the first chunk = "failed before first token" (coupon refunded); a throw after = mid-stream failure (coupon spent).
import Anthropic from '@anthropic-ai/sdk';

export const SYSTEM_PROMPT = 'You are a helpful, honest general-purpose assistant. Answer concisely. Do not ask who the user is or for personal information. ' +
  'Do not claim to store, remember or log anything about the user or the conversation; you only see the messages sent in this request.';

export function createAnthropicModel({ apiKey }) {
  // maxRetries 2 + timeout as in 188; no custom headers, so nothing about the end user (IP, UA) is forwarded.
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  return {
    kind: 'anthropic',
    async *stream({ model, system, messages, maxTokens, effort, signal }) {
      const s = client.messages.stream({ model, max_tokens: maxTokens, system, messages, output_config: { effort } }, { signal });
      for await (const ev of s) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield ev.delta.text;
      }
      const final = await s.finalMessage();
      if (final.stop_reason === 'refusal') throw Object.assign(new Error('refusal'), { refusal: true });
    },
  };
}

// OpenRouter (OpenAI-compatible SSE). Every request forces zero-data-retention routing: provider.zdr = true and
// data_collection = "deny" (https://openrouter.ai/docs/features/zdr). No `user` field and no end-user headers are sent.
export const OPENROUTER_IDS = { 'claude-haiku-5-5': 'anthropic/claude-haiku-5.5', 'claude-sonnet-5-5': 'anthropic/claude-sonnet-5.5' };

export function createOpenRouterModel({ apiKey, fetchImpl = fetch, baseUrl = 'https://openrouter.ai/api/v1' }) {
  return {
    kind: 'openrouter',
    async *stream({ model, system, messages, maxTokens, signal }) {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OPENROUTER_IDS[model] || model,
          messages: [{ role: 'system', content: system }, ...messages],
          max_tokens: maxTokens,
          stream: true,
          provider: { zdr: true, data_collection: 'deny' },
        }),
      });
      if (!res.ok || !res.body) throw Object.assign(new Error(`openrouter ${res.status}`), { status: res.status });
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue; // ": OPENROUTER PROCESSING" keep-alives and blank lines
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          if (ev.error) throw Object.assign(new Error('openrouter stream error'), { status: Number(ev.error.code) || 502 });
          const text = ev.choices?.[0]?.delta?.content;
          if (text) yield text;
        }
      }
    },
  };
}

/** Canned answer. Dev triggers in the last user message: "[fail-before]" throws before the first token, "[fail-mid]" after a few. */
export function createMockModel({ delayMs = 15 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    kind: 'mock',
    async *stream({ messages, model, signal }) {
      const last = messages[messages.length - 1].content;
      if (last.includes('[fail-before]')) throw Object.assign(new Error('mock fail'), { status: 529 });
      const words = `This is a mock answer from ${model}. Your coupon was punched and no model was called.`.split(' ');
      for (let i = 0; i < words.length; i++) {
        if (signal?.aborted) return;
        if (delayMs) await sleep(delayMs);
        if (i === 4 && last.includes('[fail-mid]')) throw Object.assign(new Error('mock fail'), { status: 529 });
        yield (i ? ' ' : '') + words[i];
      }
    },
  };
}
