// Builds the injectable context shared by all modules. Tests pass their own config / db / rpc / model / now.
import fs from 'node:fs';
import { ZERO, lc, isAddr } from './util.mjs';

export function createContext({ config, db, rpc, keys, model, trial, now = Date.now, logEvent = () => {} }) {
  let tok = { at: 0, v: null };
  const ctx = {
    config, db, rpc, keys, model, trial, now, logEvent,
    breaker: { fails: 0, openUntil: 0 },
    statusCache: { at: 0, v: null },
    /** token.json is the single source for the CA. Zero address / null = not launched. Re-read at most every 10 s. */
    token() {
      if (ctx.now() - tok.at < 10_000 && tok.v) return tok.v;
      let j = {};
      try { j = JSON.parse(fs.readFileSync(config.tokenJsonPath, 'utf8')); } catch {}
      const address = isAddr(j.address) && lc(j.address) !== ZERO ? lc(j.address) : null;
      const launched = !!address && config.tokensPerCoupon !== null;
      tok = { at: ctx.now(), v: { address, symbol: address ? j.symbol ?? null : null, launched, holdLaunched: !!address && config.holdMin !== null } };
      return tok.v;
    },
    /** Test hook: drop the token.json cache. */
    reloadToken() { tok = { at: 0, v: null }; },
  };
  return ctx;
}
