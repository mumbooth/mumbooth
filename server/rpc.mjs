// Chain access (read-only). Real = viem; mock = in-memory (tests) with the documented `0xmock…` shortcut for dev.
import { createPublicClient, defineChain, http, fallback, keccak256, toHex, pad, parseAbi } from 'viem';
import { RpcError, lc } from './util.mjs';

export const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)']);
export const topicAddr = (a) => pad(lc(a), { size: 32 });
/** Mock tx-hash shortcut: 0xmock<K>c[-_a-z0-9]{0,40} = a plain ETH transfer signer -> treasury worth K * PRICE_WEI. 0xmockpending… = not mined, 0xmockfail… = reverted. */
export const MOCK_HASH_RE = /^0xmock(?:(\d{1,4})c[-_a-z0-9]{0,40}|pending[-_a-z0-9]{0,40}|fail[-_a-z0-9]{0,40})$/;

export function createRealRpc({ urls, chainId }) {
  const def = defineChain({ id: chainId, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: urls } } });
  const transport = urls.length > 1 ? fallback(urls.map((u) => http(u, { timeout: 15_000 }))) : http(urls[0], { timeout: 15_000 });
  const pub = createPublicClient({ chain: def, transport });
  // Never keep viem's message: it can echo addresses / calldata. Callers only need "rpc failed".
  const w = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e instanceof RpcError) throw e; throw Object.assign(new RpcError('rpc failed'), { rpcName: e?.name }); } };
  const notFound = (e) => e?.name === 'TransactionReceiptNotFoundError' || e?.name === 'TransactionNotFoundError';
  return {
    kind: 'real',
    getBalance: w((a) => pub.getBalance({ address: a })),
    tokenBalance: w((token, a) => pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [a] })),
    tokenSupply: w((token) => pub.readContract({ address: token, abi: ERC20, functionName: 'totalSupply' })),
    tokenDecimals: w(async (token) => Number(await pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' }))),
    getTransaction: w(async (hash) => {
      try { const t = await pub.getTransaction({ hash }); return { from: lc(t.from), to: t.to ? lc(t.to) : null, value: t.value, input: t.input }; } catch (e) { if (notFound(e)) return null; throw e; }
    }),
    getReceipt: w(async (hash) => {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: Number(r.blockNumber), logs: r.logs.map((l) => ({ address: lc(l.address), topics: l.topics, data: l.data })) };
      } catch (e) { if (notFound(e)) return null; throw e; }
    }),
  };
}

/** In-memory chain. addTx() registers an explicit tx + receipt. Anything matching MOCK_HASH_RE is synthesised on demand. */
export function createMockRpc({ treasury, priceWei = 20_000_000_000_000n, decimals = 18 } = {}) {
  const txs = new Map(), balances = new Map(), tokenBal = new Map(), credited = new Set();
  const m = { kind: 'mock', down: false, decimals };
  const chk = () => { if (m.down) throw new RpcError('mock rpc down'); };
  Object.assign(m, {
    setDown(v) { m.down = !!v; },
    setBalance(a, v) { balances.set(lc(a), BigInt(v)); },
    setTokenBalance(token, a, v) { tokenBal.set(`${lc(token)}|${lc(a)}`, BigInt(v)); },
    /** tx: {from, to, value, input='0x'}; logs: [{token, from, to, value}] */
    addTx(hash, tx, { logs = [], status = 'success' } = {}) {
      txs.set(lc(hash), {
        tx: { from: lc(tx.from), to: tx.to ? lc(tx.to) : null, value: BigInt(tx.value ?? 0), input: tx.input ?? '0x' },
        receipt: { status, blockNumber: 1000, logs: logs.map((l) => ({ address: lc(l.token), topics: [TRANSFER_TOPIC, topicAddr(l.from), topicAddr(l.to)], data: pad(toHex(BigInt(l.value)), { size: 32 }) })) },
      });
    },
    async getBalance(a) { chk(); return balances.get(lc(a)) ?? 0n; },
    async tokenBalance(token, a) { chk(); return tokenBal.get(`${lc(token)}|${lc(a)}`) ?? 0n; },
    async tokenSupply(token) { chk(); return m.supply ?? 10n ** 27n; },
    setSupply(v) { m.supply = BigInt(v); },
    async tokenDecimals() { chk(); return m.decimals; },
    async getTransaction(hash, hint = {}) {
      chk();
      const h = lc(hash), e = txs.get(h);
      if (e) return e.tx;
      const mm = MOCK_HASH_RE.exec(h);
      if (!mm || h.startsWith('0xmockpending')) return null;
      if (h.startsWith('0xmockfail')) return { from: lc(hint.from ?? '0x0'), to: treasury, value: priceWei, input: '0x' };
      const value = BigInt(mm[1]) * priceWei;
      if (!credited.has(h)) { credited.add(h); balances.set(treasury, (balances.get(treasury) ?? 0n) + value); }
      return { from: lc(hint.from), to: treasury, value, input: '0x' };
    },
    async getReceipt(hash) {
      chk();
      const h = lc(hash), e = txs.get(h);
      if (e) return e.receipt;
      if (!MOCK_HASH_RE.test(h) || h.startsWith('0xmockpending')) return null;
      return { status: h.startsWith('0xmockfail') ? 'reverted' : 'success', blockNumber: 1000, logs: [] };
    },
  });
  return m;
}
