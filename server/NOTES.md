# MUMBOOTH server · notes

Node >= 22.13 · fastify 5 · viem 2 · `@anthropic-ai/sdk` 1.2 · `@cloudflare/blindrsa-ts` 0.4.6 · SQLite via `node:sqlite`. Spec = BRIEF.md §5 (this server is the source of truth).

## Run
- `npm install` · `npm test` (48 tests, no network) · `npm run bundle` (rebuilds `web/js/vendor/blindrsa.js`, unminified).
- **`npm run dev`** = `RPC_MODE=mock MODEL_MODE=mock SERVE_WEB=1 PORT=4930` → http://localhost:4930 serves `../web` (clean URLs: `/booth`, `/docs`, `/privacy`, `/proof`) and `/api/*`.
  State lives in `server/data/mock/` (db + `keys/k1.pem`) and **survives restarts** so cached key fingerprints stay valid. `MOCK_FRESH=1 npm run dev` wipes it. Add `server/data` to .gitignore.
- Production: `node index.mjs` with `/etc/mumbooth.env` (needs `ANTHROPIC_API_KEY`, `TREASURY`).

## Mock chain (`RPC_MODE=mock`)
Any tx hash matching `^0xmock(\d{1,4})c[-_a-z0-9]{0,40}$` is a **plain ETH transfer from the signer (the wallet that signed the issue request) to the treasury worth K × PRICE_WEI**, K = the digits before `c`. Hashes must be unique per purchase (tx_used otherwise); `0xmock5c-` + random suffix works.
- `0xmock5c-abc123` → pays for 5 coupons (the issue request may ask for 1..5). `0xmock25c-<rand>` → 25.
- `0xmockpending…` → `404 tx_not_found` forever. `0xmockfail…` → `400 tx_failed`.
- Each distinct 0xmock hash credits the mock treasury, so `/api/status.ethReceivedWei` grows (`treasury` in mock = `0x1111…1111`).
- The signature rules are NOT mocked: the browser must still `personal_sign` the real message with the claimed `address` (a dev wallet / test key, e.g. viem `privateKeyToAccount`).
- The shortcut is refused when `RPC_MODE` is not `mock`. Mock token launch: put a non-zero `address` in `web/token.json` AND set `TOKENS_PER_COUPON` / `HOLD_MIN`; the mock chain has no token balances/receipts for the dev server (use tests for burn/hold paths).

## Mock model (`MODEL_MODE=mock`)
Streams a canned sentence word by word (15 ms). Dev triggers inside the last user message: `[fail-before]` → 503 and coupon refunded; `[fail-mid]` → error event after 4 words, coupon spent.

## API notes beyond the brief
- Bigints are decimal **strings** in JSON (`priceWei`, `ethReceivedWei`, `burnedWei`, `token.tokensPerCoupon`, `token.holdMin`). `/api/proof.purchases[].at` = unix **ms**. `/api/status` also returns `issuedByKey` (anonymity-set size per key id) and `rpc: "ok"|"down"`.
- Hold claim with the **same batch** twice = idempotent (identical sigs, so a reload mid-claim recovers); a different batch the same UTC day = `409 already_claimed {nextAt}`.
- Overpay: you may claim up to floor(value/price) coupons; claiming fewer burns the remainder (tx can only be used once).
- `/api/chat` sends `meta` on the first token (not before); until then errors are plain JSON and the reservation is refunded. Exactly `need` coupons must be sent (more → 400).
- Burn is recognised by `tx.to == token CA` + `Transfer(signer → 0x…dEaD)` logs from the CA; before CA/`TOKENS_PER_COUPON` exist any non-treasury contract call → `409 not_launched`. `golive.sh` needs `address` in token.json AND `TOKENS_PER_COUPON` (burn) / `HOLD_MIN` (hold) set; the server re-reads token.json every 10 s (restart not strictly needed for the address).
- The key file is created on first start with meta `keys/k1.json` (issueUntil +30 d, redeemUntil +60 d, fixed at creation).

## Design deviations from BRIEF
- `blindSign` runs through `node:crypto` raw RSA (RSA_NO_PADDING) instead of the lib's pure-JS bignum: 0.35 ms vs ~200 ms per signature (500 coupons = 100 s blocking the event loop otherwise). Same RSASP1 + the lib's `m == s^e` check; asserted byte-identical to the lib in `tests/blind.test.mjs`. Everything else (verify, suite) is the lib.
- Model calls pass `output_config.effort` (`low` fast, `medium` deep) and leave `thinking` unset so thinking tokens don't eat `max_tokens`. Not verified against the live API (no key here): the lead's e2e is the first real call.
- Explorer base URL is `EXPLORER` env (default `https://explorer.chain.robinhood.com`, unverified) — set the real Blockscout URL in `/etc/mumbooth.env`.
