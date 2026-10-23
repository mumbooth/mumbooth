// Injected EIP-1193 wallet only (MetaMask, Rabby, in-app wallet browsers). Used ONLY to buy coupons.
// After a purchase is claimed, the wallet is not used again.

import { ClientError } from './errors.js';
import { utf8Hex, DEAD_ADDRESS } from './util.js';

export const CHAIN_ID = 4663;
export const CHAIN_HEX = '0x' + CHAIN_ID.toString(16); // 0x1237
export const RPC_URL = 'https://robinhood-rpc.publicnode.com';
export const DEFAULT_EXPLORER = 'https://explorer.chain.robinhood.com';

/** Exact claim texts (BRIEF §2 / §3d). Lowercase hex everywhere. */
export function issueMessage({ txHash, batchHash, count }) {
  return [
    'MUMBOOTH issue v1',
    `chain: ${CHAIN_ID}`,
    `tx: ${String(txHash).toLowerCase()}`,
    `batch: ${String(batchHash).toLowerCase()}`,
    `count: ${count}`,
  ].join('\n');
}
export function holdMessage({ address, day, batchHash, count }) {
  return [
    'MUMBOOTH hold v1',
    `chain: ${CHAIN_ID}`,
    `address: ${String(address).toLowerCase()}`,
    `day: ${day}`,
    `batch: ${String(batchHash).toLowerCase()}`,
    `count: ${count}`,
  ].join('\n');
}

export function provider() {
  const eth = globalThis.ethereum;
  if (!eth || typeof eth.request !== 'function') return null;
  return eth;
}
export const hasWallet = () => !!provider();

function mapWalletError(e) {
  if (e instanceof ClientError) return e;
  const code = e?.code ?? e?.data?.originalError?.code;
  if (code === 4001 || code === 'ACTION_REJECTED' || /reject|denied|cancel/i.test(e?.message || '')) {
    return new ClientError('user_rejected');
  }
  if (/insufficient funds/i.test(e?.message || '')) return new ClientError('insufficient_funds');
  const msg = (e?.message || 'Wallet error').split('\n')[0].slice(0, 200);
  return new ClientError('wallet_error', `Wallet error: ${msg}`);
}

async function rpc(method, params = []) {
  const eth = provider();
  if (!eth) throw new ClientError('no_wallet');
  try {
    return await eth.request({ method, params });
  } catch (e) {
    throw Object.assign(mapWalletError(e), { raw: e });
  }
}

/** Ask for accounts; returns lowercase address. */
export async function connect() {
  const accounts = await rpc('eth_requestAccounts');
  if (!accounts?.length) throw new ClientError('no_wallet', 'The wallet returned no account.');
  return String(accounts[0]).toLowerCase();
}

export async function currentChainId() {
  const id = await rpc('eth_chainId');
  return parseInt(id, 16);
}

/** Switch to Robinhood Chain, adding it if the wallet doesn't know it. */
export async function ensureChain(explorer = DEFAULT_EXPLORER) {
  if ((await currentChainId()) === CHAIN_ID) return;
  const eth = provider();
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    const code = e?.code ?? e?.data?.originalError?.code;
    if (code === 4001) throw new ClientError('user_rejected');
    // 4902 = unknown chain; some wallets use -32603 with a message instead.
    try {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX,
          chainName: 'Robinhood Chain',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [explorer || DEFAULT_EXPLORER],
        }],
      });
    } catch (e2) {
      if ((e2?.code ?? 0) === 4001) throw new ClientError('user_rejected');
      throw new ClientError('wrong_chain');
    }
  }
  let id;
  try { id = await currentChainId(); } catch { id = null; }
  if (id !== CHAIN_ID) throw new ClientError('wrong_chain');
}

export async function getBalance(address) {
  return BigInt(await rpc('eth_getBalance', [address, 'latest']));
}

/** Rough gas cost for a simple transfer (or token transfer), with headroom. */
export async function estimateGasCost(gasUnits = 21000n) {
  let price;
  try { price = BigInt(await rpc('eth_gasPrice')); } catch { price = 100000000n; } // 0.1 gwei fallback
  return gasUnits * price * 3n; // ×3 headroom for L2 data fees
}

/** Check balance ≥ value + gas. Throws insufficient_funds with numbers. */
export async function checkFunds(address, valueWei, gasUnits = 21000n) {
  const [bal, gas] = await Promise.all([getBalance(address), estimateGasCost(gasUnits)]);
  if (bal < valueWei + gas) {
    throw new ClientError('insufficient_funds', undefined, { balance: bal.toString(), need: (valueWei + gas).toString() });
  }
  return { balance: bal, gas };
}

export async function sendEth({ from, to, valueWei }) {
  const hash = await rpc('eth_sendTransaction', [{ from, to, value: '0x' + valueWei.toString(16) }]);
  return String(hash).toLowerCase();
}

/** ERC-20 transfer(dead, amount) — the burn path (only rendered after the token exists). */
export async function sendBurn({ from, token, amountUnits }) {
  const data = '0xa9059cbb'
    + DEAD_ADDRESS.slice(2).toLowerCase().padStart(64, '0')
    + amountUnits.toString(16).padStart(64, '0');
  const hash = await rpc('eth_sendTransaction', [{ from, to: token, data, value: '0x0' }]);
  return String(hash).toLowerCase();
}

/** ERC-20 balanceOf via the wallet's RPC. */
export async function tokenBalance(token, address) {
  const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
  return BigInt(await rpc('eth_call', [{ to: token, data }, 'latest']));
}

/** personal_sign of the exact UTF-8 text. */
export async function personalSign(address, text) {
  return rpc('personal_sign', [utf8Hex(text), address]);
}

/** Receipt via the wallet's RPC (null while pending). */
export async function getReceipt(hash) {
  try { return await rpc('eth_getTransactionReceipt', [hash]); } catch { return null; }
}

export function onAccountsChanged(fn) {
  const eth = provider();
  eth?.on?.('accountsChanged', fn);
}
