// RFC 9474 RSABSSA-SHA384-PSS-Deterministic. Verification and (de)serialisation via @cloudflare/blindrsa-ts 0.4.6.
// Signing: the lib's blindSign is a pure-JS bignum (~200 ms per call, blocks the loop; 500 coupons = 100 s). The RSASP1 step is
// plain m^d mod n, so we do it with node:crypto raw RSA (0.35 ms) and keep the lib's m == s^e check. Output is byte-identical
// (asserted against the lib in tests/blind.test.mjs).
import { constants, privateDecrypt, publicEncrypt } from 'node:crypto';
import { RSABSSA } from '@cloudflare/blindrsa-ts';

export const ALG = 'RSABSSA-SHA384-PSS-Deterministic';
export const MODULUS_BITS = 2048;
export const KLEN = MODULUS_BITS / 8;
export const MSG_LEN = 32;
export const suite = RSABSSA.SHA384.PSS.Deterministic();
if (suite.toString() !== ALG) throw new Error('unexpected suite ' + suite.toString());

export const generateKeyPair = () => RSABSSA.SHA384.generateKey({ modulusLength: MODULUS_BITS, publicExponent: Uint8Array.from([1, 0, 1]) });

/** blind_sig = RSASP1(sk, blinded). Throws on malformed input (>= n, wrong length). */
export function blindSign(nodePriv, nodePub, blinded) {
  if (blinded.length !== KLEN) throw new Error('bad length');
  let s;
  try { s = privateDecrypt({ key: nodePriv, padding: constants.RSA_NO_PADDING }, blinded); } catch { throw new Error('bad input'); }
  const back = publicEncrypt({ key: nodePub, padding: constants.RSA_NO_PADDING }, s);
  if (!back.equals(blinded)) throw new Error('signing failure');
  return s;
}

/** Verify a finalized coupon signature over the 32-byte message. */
export async function verifyCoupon(publicKey, msg, sig) {
  // Copy into plain Uint8Arrays: the lib does `x.slice().buffer`, which for a pooled Node Buffer is the whole pool, not the view.
  try { return await suite.verify(publicKey, new Uint8Array(sig), new Uint8Array(msg)); } catch { return false; }
}
