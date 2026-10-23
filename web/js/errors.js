// Human-readable messages for every error code in BRIEF §5, plus wallet/client-side codes.
// Never echo server-provided `message` through innerHTML — callers render with textContent.

import { formatEth, fmtDateTime } from './util.js';

const MSG = {
  // generic / transport
  network: () => 'Could not reach the booth server. Check your connection and try again.',
  stream_broken: () => 'The connection dropped while the answer was streaming.',
  bad_response: () => 'The server sent an answer this page did not understand. Try again in a moment.',
  bad_request: () => 'The request was rejected as malformed. Reload the page and try again.',
  rate_limited: () => 'Too many requests from this network. Wait a minute and try again.',
  rpc_unavailable: () => 'The server cannot read Robinhood Chain right now. Your payment is safe — retry in a minute; the claim can be repeated.',

  // issue / claim
  too_many_coupons: (d) => `Too many coupons in one batch${d.allowed ? ` — this payment allows ${d.allowed}` : ''}. Pick a smaller pack.`,
  underpaid: (d) => `The payment is below the coupon price${d.priceWei ? ` (${formatEth(d.priceWei)} ETH per coupon)` : ''}.`,
  wrong_recipient: () => 'That transaction was not sent to the MUMBOOTH treasury, so it cannot pay for coupons.',
  unsupported_tx: () => 'That transaction is not a plain ETH transfer to the treasury (or a token burn to the dead address).',
  tx_failed: () => 'That transaction failed on chain (reverted). No coupons can be issued for it.',
  tx_not_found: () => 'Transaction not confirmed yet. Waiting for Robinhood Chain…',
  bad_signature: () => 'The wallet signature did not verify. Sign the claim message again.',
  signer_mismatch: () => 'The signature came from a different address than the one that sent the transaction. Smart-contract wallets are not supported — use a regular wallet account (EOA).',
  tx_used: () => 'This transaction was already claimed with a different batch of coupons. If you claimed it in another browser, the coupons are there.',
  not_launched: () => 'The token does not exist yet, so burns and holder coupons are not open. Buying with ETH works now.',
  below_minimum: (d) => `This wallet holds less than the minimum for daily coupons${d.holdMin ? ` (needs ${Number(d.holdMin).toLocaleString('en-US')} tokens, holds ${Number(d.balance ?? 0).toLocaleString('en-US')})` : ''}.`,
  already_claimed: (d) => `Daily coupons for this wallet were already claimed today.${d.nextAt ? ` Next claim: ${fmtDateTime(d.nextAt)}.` : ''}`,
  bad_day: () => 'The claim was signed for a different UTC day. Check your device clock and sign again.',

  // chat
  context_too_long: (d) => `This conversation is too long to send${d.maxChars ? ` (limit ${Number(d.maxChars).toLocaleString('en-US')} characters)` : ''}. Start a new booth or shorten your message.`,
  coupons_required: (d) => `Not enough coupons for this model${d.need ? `: needs ${d.need}, you have ${d.got ?? 0}` : ''}. Buy more or switch to fast.`,
  coupon_invalid: () => 'One of your coupons did not verify (wrong key or damaged). It was set aside; nothing was charged.',
  coupon_spent: () => 'One coupon was already used (maybe in another tab). It was removed from this browser.',
  key_expired: () => 'These coupons were signed with a key that has expired. They can no longer be redeemed.',
  trial_exhausted: (d) => `Trial used up for today on this network.${d.resetAt ? ` It resets at ${fmtDateTime(d.resetAt)}.` : ' It resets at 00:00 UTC.'} Shared networks (office, mobile carrier, VPN) share one counter, so it can run out faster.`,
  trial_paused: () => 'The free trial is paused for today — the daily budget for all visitors ran out. Coupons still work.',
  model_unavailable: () => 'The model is unavailable right now. No coupon was spent. Try again in a minute.',
  model_error: () => 'The model stopped mid-answer.',

  // client-side
  no_wallet: () => 'No wallet found in this browser. Open this page in your wallet app’s browser (MetaMask, Rabby, Coinbase Wallet…) or install a wallet extension.',
  user_rejected: () => 'You cancelled the request in your wallet. Nothing was sent.',
  wrong_chain: () => 'Your wallet is not on Robinhood Chain (4663) and could not switch automatically. Add it manually: RPC https://robinhood-rpc.publicnode.com, chain ID 4663, currency ETH.',
  insufficient_funds: () => 'Not enough ETH on Robinhood Chain (4663) for this pack plus gas.',
  verify_failed: () => 'A signed coupon did not verify against the published key. Nothing was saved as valid; your payment is recorded — retry the claim.',
  key_unavailable: () => 'Could not load the signing key from the server. Try again in a moment.',
  crypto_unavailable: () => 'This browser lacks the crypto features needed to make blind coupons. Try a current Chrome, Safari or Firefox.',
  storage_failed: () => 'Could not save to this browser’s storage. Coupons cannot be kept here — try a normal (non-private) window.',
  claim_timeout: () => 'The transaction has not confirmed after 5 minutes. It is saved here — press Retry claim later.',
  no_coupons: () => 'No coupons left in this browser.',
};

/** Turn anything thrown into a human sentence. */
export function humanError(err) {
  if (!err) return 'Something went wrong.';
  const code = err.code || (err.name === 'AbortError' ? 'aborted' : null);
  if (code === 'aborted') return 'Stopped.';
  const d = err.detail || {};
  if (code && MSG[code]) return MSG[code](d);
  if (typeof code === 'string' && code.startsWith('http_')) {
    const s = Number(code.slice(5));
    if (s >= 500) return `The server had a problem (HTTP ${s}). Try again in a moment.`;
    return `Request failed (HTTP ${s}).`;
  }
  if (err.message) return String(err.message).slice(0, 300);
  return 'Something went wrong.';
}

export function errorCode(err) {
  return err?.code || null;
}

export class ClientError extends Error {
  constructor(code, message, detail = {}) {
    super(message || code);
    this.code = code;
    this.detail = detail;
  }
}
