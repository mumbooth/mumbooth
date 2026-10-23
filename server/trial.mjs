// Free trial counter. Keyed by HMAC-SHA256(dailySalt, ip), held in memory only; salt + map are dropped when the UTC day changes.
// This is a per-IP-per-day key, not anonymity (the IPv4 space is brute-forceable even with a salt).
import { createHmac, randomBytes } from 'node:crypto';
import { ApiError, utcDay, nextUtcMidnight } from './util.mjs';

export function createTrial({ perDay = 3, cap = 1500, now = Date.now } = {}) {
  let day = '', salt = null, map = new Map(), total = 0, saltId = 0;
  const roll = () => {
    const d = utcDay(now());
    if (d !== day) { day = d; salt = randomBytes(32); map = new Map(); total = 0; saltId++; }
  };
  const key = (ip) => createHmac('sha256', salt).update(String(ip ?? '')).digest('hex');
  return {
    /** Count one message or throw 429. Returns a token for refund(). */
    reserve(ip) {
      roll();
      const k = key(ip);
      if ((map.get(k) ?? 0) >= perDay) throw new ApiError(429, 'trial_exhausted', 'Free trial used up for today on this network.', { resetAt: nextUtcMidnight(now()) });
      if (total >= cap) throw new ApiError(429, 'trial_paused', 'The free trial is paused for today. Coupons still work.', { resetAt: nextUtcMidnight(now()) });
      map.set(k, (map.get(k) ?? 0) + 1); total++;
      return { k, saltId };
    },
    refund(t) {
      if (!t || t.saltId !== saltId) return;
      const c = map.get(t.k) ?? 0;
      if (c > 0) { map.set(t.k, c - 1); total--; }
    },
    // test hooks (no ip or hash is ever exposed)
    _stats: () => { roll(); return { day, total, saltId, keys: map.size, salt: salt.toString('hex') }; },
  };
}
