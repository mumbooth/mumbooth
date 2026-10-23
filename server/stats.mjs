// GET /api/status, GET /api/proof, and the hourly sweep of spent rows whose key is past redeemUntil.
import { RpcError, DEAD, utcDay } from './util.mjs';

async function chainNumbers(ctx) {
  const { config, rpc } = ctx;
  const c = ctx.statusCache;
  if (c.v && ctx.now() - c.at < config.statusTtlMs) return c.v;
  if (c.pending) return c.pending;
  c.pending = (async () => {
    let v;
    try {
      const tok = ctx.token();
      const eth = await rpc.getBalance(config.treasury);
      let burned = null;
      if (tok.address) burned = await rpc.tokenBalance(tok.address, DEAD);
      v = { ethReceivedWei: eth.toString(), burnedWei: burned === null ? null : burned.toString(), rpc: 'ok' };
    } catch (e) {
      if (!(e instanceof RpcError)) ctx.logEvent('status_error', {});
      v = { ethReceivedWei: null, burnedWei: null, rpc: 'down' };
    }
    c.v = v; c.at = ctx.now(); c.pending = null;
    return v;
  })();
  return c.pending;
}

export async function status(ctx) {
  const { config, db } = ctx;
  const tok = ctx.token();
  const issued = Number(db.get('SELECT COALESCE(SUM(n),0) AS n FROM issued').n);
  const purchases = Number(db.get("SELECT COUNT(*) AS n FROM issued WHERE kind IN ('eth','burn')").n);
  const spent = Number(db.get("SELECT v FROM counters WHERE k = 'spent_total'").v);
  const issuedByKey = Object.fromEntries(db.all('SELECT epoch, SUM(n) AS n FROM issued GROUP BY epoch').map((r) => [r.epoch, Number(r.n)]));
  const chain = await chainNumbers(ctx);
  return {
    chainId: config.chainId,
    treasury: config.treasury,
    priceWei: config.priceWei.toString(),
    maxPack: config.maxPack,
    holdPerDay: config.holdPerDay,
    token: {
      address: tok.address, symbol: tok.symbol,
      tokensPerCoupon: tok.address && config.tokensPerCoupon !== null ? config.tokensPerCoupon.toString() : null,
      holdMin: tok.address && config.holdMin !== null ? config.holdMin.toString() : null,
    },
    keyId: ctx.keys.current,
    issued, spent, purchases, issuedByKey,
    ethReceivedWei: chain.ethReceivedWei,
    burnedWei: chain.burnedWei,
    rpc: chain.rpc,
    trial: { perDay: 3 },
    models: { fast: { coupons: 1 }, deep: { coupons: 3 } },
    explorer: config.explorer,
  };
}

/** `at` is unix milliseconds. */
export function proof(ctx) {
  const { db } = ctx;
  const day = utcDay(ctx.now());
  return {
    purchases: db.all("SELECT tx_hash AS txHash, kind, n, at FROM issued WHERE kind IN ('eth','burn') ORDER BY at DESC, rowid DESC LIMIT 100").map((r) => ({ txHash: r.txHash, kind: r.kind, n: Number(r.n), at: Number(r.at) })),
    holdClaims: {
      today: Number(db.get("SELECT COUNT(*) AS n FROM issued WHERE kind = 'hold' AND tx_hash LIKE ?", `hold:%:${day}`).n),
      total: Number(db.get("SELECT COUNT(*) AS n FROM issued WHERE kind = 'hold'").n),
    },
    spent: Number(db.get("SELECT v FROM counters WHERE k = 'spent_total'").v),
    issued: Number(db.get('SELECT COALESCE(SUM(n),0) AS n FROM issued').n),
  };
}

export function sweepSpent(ctx) {
  for (const k of ctx.keys.publicList()) if (ctx.now() > Date.parse(k.redeemUntil)) ctx.db.run('DELETE FROM spent WHERE epoch = ?', k.id);
}
