// Local wallet of coupons + pending purchases + chat history + key cache, all in IndexedDB.
// Everything here is stored as plain, readable data (we make no other claim). If IndexedDB is unavailable we fall back
// to memory and the UI shows a banner: coupons then vanish with the tab.

const DB_NAME = 'mumbooth';
const DB_VERSION = 1;
const STORES = {
  coupons: 'id',   // {id, no, epoch, msg, sig, status:'ok'|'inflight'|'spent'|'invalid'|'expired', addedAt}
  pending: 'id',   // {id, kind, keyId, msgs[], inv[], blinded[], count, valueWei, txHash, sig, address, day, stage, createdAt}
  booths: 'id',    // {id, title, createdAt, updatedAt, messages:[{role, content, note?, cost?}]}
  keys: 'id',      // {id, spki, fingerprint, issueUntil, redeemUntil, seenAt}
  meta: 'k',       // {k, v}
};

let dbPromise = null;
let mode = 'unknown'; // 'indexeddb' | 'memory'
const mem = Object.fromEntries(Object.keys(STORES).map((s) => [s, new Map()]));

const bus = new EventTarget();
let channel = null;
try { channel = new BroadcastChannel('mumbooth'); } catch { channel = null; }
if (channel) channel.onmessage = (e) => bus.dispatchEvent(new CustomEvent('change', { detail: { store: e.data?.store, remote: true } }));

/** Subscribe to changes (from this tab or other tabs). Returns unsubscribe fn. */
export function onChange(fn) {
  const h = (e) => fn(e.detail || {});
  bus.addEventListener('change', h);
  return () => bus.removeEventListener('change', h);
}
function changed(store) {
  bus.dispatchEvent(new CustomEvent('change', { detail: { store } }));
  try { channel?.postMessage({ store }); } catch { /* ignore */ }
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      if (!('indexedDB' in window) || !window.indexedDB) throw new Error('no idb');
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      mode = 'memory';
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { mode = 'memory'; resolve(null); }, 4000);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    req.onsuccess = () => { clearTimeout(timer); mode = 'indexeddb'; resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); mode = 'memory'; resolve(null); };
    req.onblocked = () => { /* another tab holds an old version; keep waiting until timeout */ };
  });
  return dbPromise;
}

/** 'indexeddb' | 'memory' — resolves after the DB open attempt. */
export async function storageMode() {
  await openDb();
  return mode;
}

/** Ask the browser not to evict our storage (best effort). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

function tx(db, store, rw = 'readonly') {
  return db.transaction(store, rw).objectStore(store);
}
function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(store) {
  const db = await openDb();
  if (!db) return Array.from(mem[store].values()).map(clone);
  return wrap(tx(db, store).getAll());
}
async function get(store, key) {
  const db = await openDb();
  if (!db) { const v = mem[store].get(key); return v ? clone(v) : undefined; }
  return wrap(tx(db, store).get(key));
}
async function putMany(store, values) {
  const db = await openDb();
  if (!db) {
    for (const v of values) mem[store].set(v[STORES[store]], clone(v));
    changed(store);
    return;
  }
  await new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const v of values) os.put(v);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
  changed(store);
}
async function delMany(store, keys) {
  const db = await openDb();
  if (!db) { for (const k of keys) mem[store].delete(k); changed(store); return; }
  await new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const k of keys) os.delete(k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  changed(store);
}
async function clearStore(store) {
  const db = await openDb();
  if (!db) { mem[store].clear(); changed(store); return; }
  await wrap(tx(db, store, 'readwrite').clear());
  changed(store);
}
function clone(v) { return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }

// ---------- meta ----------
export async function getMeta(k, dflt = null) {
  const r = await get('meta', k);
  return r ? r.v : dflt;
}
export async function setMeta(k, v) {
  await putMany('meta', [{ k, v }]);
}

// ---------- coupons ----------
function isCouponShape(c) {
  return c && typeof c.epoch === 'string' && typeof c.msg === 'string' && typeof c.sig === 'string'
    && c.msg.length > 20 && c.msg.length < 200 && c.sig.length > 100 && c.sig.length < 2000;
}

/** Add verified coupons [{epoch,msg,sig}]. Deduplicates by msg. Returns number added. */
export async function addCoupons(list) {
  const existing = new Set((await getAll('coupons')).map((c) => c.id));
  let serial = Number(await getMeta('serial', 0)) || 0;
  const now = Date.now();
  const fresh = [];
  for (const c of list) {
    if (!isCouponShape(c) || existing.has(c.msg)) continue;
    existing.add(c.msg);
    serial += 1;
    fresh.push({ id: c.msg, no: serial, epoch: c.epoch, msg: c.msg, sig: c.sig, status: 'ok', addedAt: now });
  }
  if (fresh.length) {
    await putMany('coupons', fresh);
    await setMeta('serial', serial);
  }
  return fresh.length;
}

export async function listCoupons() {
  const all = await getAll('coupons');
  return all.sort((a, b) => a.no - b.no);
}

async function setStatus(ids, status) {
  const all = await getAll('coupons');
  const want = new Set(ids);
  const upd = all.filter((c) => want.has(c.id)).map((c) => ({ ...c, status }));
  if (upd.length) await putMany('coupons', upd);
}

/**
 * Take `n` usable coupons for the given epochs (oldest first) and mark them in flight.
 * Returns the coupon records or null if not enough.
 */
export async function takeCoupons(n, validEpochs) {
  const all = await listCoupons();
  const ok = all.filter((c) => c.status === 'ok' && (!validEpochs || validEpochs.has(c.epoch)));
  if (ok.length < n) return null;
  const picked = ok.slice(0, n);
  await setStatus(picked.map((c) => c.id), 'inflight');
  return picked;
}
export const releaseCoupons = (ids) => setStatus(ids, 'ok');
export const markSpent = (ids) => setStatus(ids, 'spent');
export const markInvalid = (ids) => setStatus(ids, 'invalid');
export const markExpired = (ids) => setStatus(ids, 'expired');
export const removeCoupons = (ids) => delMany('coupons', ids);

/** On page load: a coupon stuck "inflight" (tab closed mid-request) goes back to "ok".
 *  If it was in fact spent, the server answers coupon_spent and we drop it then. */
export async function recoverInflight() {
  const all = await getAll('coupons');
  const stuck = all.filter((c) => c.status === 'inflight');
  if (stuck.length) await putMany('coupons', stuck.map((c) => ({ ...c, status: 'ok' })));
}

/** Drop the receipts of spent coupons (keeps the wallet tidy). */
export async function clearSpent() {
  const all = await getAll('coupons');
  await delMany('coupons', all.filter((c) => c.status === 'spent').map((c) => c.id));
}

export async function countUsable(validEpochs) {
  const all = await getAll('coupons');
  return all.filter((c) => c.status === 'ok' && (!validEpochs || validEpochs.has(c.epoch))).length;
}

/** JSON export of unspent coupons. These are bearer tokens: whoever has the file can spend them. */
export async function exportCoupons() {
  const all = await listCoupons();
  const coupons = all.filter((c) => c.status === 'ok' || c.status === 'inflight').map(({ epoch, msg, sig }) => ({ epoch, msg, sig }));
  return JSON.stringify({ format: 'mumbooth-coupons', version: 1, exportedAt: new Date().toISOString(), coupons }, null, 2);
}

/** Parse an export file. Returns [{epoch,msg,sig}] (unverified — caller verifies against the key). */
export function parseCouponFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const list = Array.isArray(data) ? data : data?.coupons;
  if (!Array.isArray(list)) throw new Error('No coupons found in that file.');
  const good = list.filter(isCouponShape).map(({ epoch, msg, sig }) => ({ epoch, msg, sig }));
  if (!good.length) throw new Error('No valid coupons found in that file.');
  return good;
}

// ---------- pending purchases ----------
export async function savePending(p) { await putMany('pending', [p]); }
export async function getPending(id) { return get('pending', id); }
export async function listPending() {
  return (await getAll('pending')).sort((a, b) => a.createdAt - b.createdAt);
}
export async function deletePending(id) { await delMany('pending', [id]); }

// ---------- booths (chat history, stored as plain text in this browser) ----------
export async function listBooths() {
  return (await getAll('booths')).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function getBooth(id) { return get('booths', id); }
export async function saveBooth(b) { await putMany('booths', [{ ...b, updatedAt: Date.now() }]); }
export async function deleteBooth(id) { await delMany('booths', [id]); }
export async function deleteAllBooths() { await clearStore('booths'); }

// ---------- signing keys cache ----------
export async function getCachedKey(id) { return get('keys', id); }
export async function listCachedKeys() { return getAll('keys'); }
export async function cacheKey(k) {
  await putMany('keys', [{ id: k.id, spki: k.spki, fingerprint: k.fingerprint, issueUntil: k.issueUntil, redeemUntil: k.redeemUntil, seenAt: Date.now() }]);
}

// ---------- forget ----------
export async function forgetEverything() {
  for (const s of ['coupons', 'pending', 'booths', 'meta']) await clearStore(s);
  // keys cache is kept on purpose: it lets you notice if the server key changes later.
}
