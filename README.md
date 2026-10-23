# MUMBOOTH

**Pay with your wallet. Chat as nobody.** — https://mumbooth.chat

Private AI chat on Robinhood Chain (chain id 4663). Your wallet buys coupons; your browser blinds them before the server signs
(RSA blind signatures, [RFC 9474](https://www.rfc-editor.org/rfc/rfc9474), suite `RSABSSA-SHA384-PSS-Deterministic`, 2048-bit).
Each message spends one coupon. The server can check that a coupon is genuine and unused, but not which wallet bought it.

This repository is the code that runs the site, published so the claims can be checked.

## How it works
1. **Pay** — your wallet sends ETH to the treasury on Robinhood Chain (a public transaction).
2. **Blind** — your browser makes random 32-byte coupons and blinds each one (`web/js/blind.js`, `web/js/vendor/blindrsa.js`).
3. **Stamp** — `POST /api/issue` checks the payment and a `personal_sign` that binds the tx to the blinded batch, then signs the
   blinded coupons (`server/issue.mjs`, `server/blind.mjs`). Your browser unblinds and verifies every signature against the
   published key.
4. **Punch** — `POST /api/chat` verifies a coupon and stores only `sha256(coupon)` + key id (no time, no IP, no model)
   (`server/chat.mjs`, `server/db.mjs`).

## What to check
| Claim | Where |
|---|---|
| Spent coupons are a hash + key id only | `server/db.mjs` (`spent` table schema) |
| The app never logs IPs, wallets, coupons or message text | `server/app.mjs` (logger), `server/tests/logging.test.mjs` |
| Access logging is off | `deploy/nginx.conf` (`access_log off`) |
| Model requests go through OpenRouter with zero-data-retention routing only (`provider.zdr: true`) | `server/model.mjs`, `server/tests/openrouter.test.mjs` |
| A coupon can't be spent twice, even in parallel | `server/chat.mjs`, `server/tests/spend.test.mjs` |
| Browser code is not minified | `web/js/` |

Current signing key: `k1`, fingerprint `sha256:35a888855d6e9692fd797568760193ad7ac34317c2906c4941e17cd2ebe85e14` — also served at https://mumbooth.chat/api/keys.
If it ever changes without notice, the browser warns you.

Limits we don't hide: buying coupons is a public transaction; buying and chatting right away can be correlated by timing; your IP is
visible to the server at the network level (we don't record it). See https://mumbooth.chat/privacy.

## Run it
```
cd server && npm install && npm test        # offline tests (mock chain + mock model)
npm run dev                                   # http://localhost:4930 with mocks, serves ../web
```
`tools/e2e.mjs` runs the full flow against a live deployment with a funded throwaway key (it sends a real transaction).

License: MIT.
