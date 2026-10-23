// Shared helpers: ApiError, RpcError, encoders. Nothing here logs anything.
import { createHash } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message, detail = {}) { super(message); this.status = status; this.code = code; this.detail = detail; }
  toBody() { return { error: this.code, message: this.message, ...this.detail }; }
}
export class RpcError extends Error {}

export const lc = (s) => String(s).toLowerCase();
export const b64 = (u8) => Buffer.from(u8).toString('base64');
export const sha256hex = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };
export const sha256buf = (u8) => createHash('sha256').update(u8).digest();

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** Strict base64 -> Buffer, or null when malformed / wrong length. */
export function unb64(s, len) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 4096 || s.length % 4 !== 0 || !B64_RE.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  if (b.toString('base64') !== s) return null;
  if (len !== undefined && b.length !== len) return null;
  return b;
}
export const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
export const isSig = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{130}$/.test(s);
export const DEAD = '0x000000000000000000000000000000000000dead';
export const ZERO = '0x0000000000000000000000000000000000000000';

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const nextUtcMidnight = (ms) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString(); };
