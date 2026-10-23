// node:sqlite wrapper. `spent` deliberately has no time / ip / model / length columns (tested).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issued(
  tx_hash TEXT PRIMARY KEY, address TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('eth','burn','hold')),
  n INT NOT NULL, epoch TEXT NOT NULL, batch_hash TEXT NOT NULL, at INT NOT NULL);
CREATE INDEX IF NOT EXISTS issued_at ON issued(at);
CREATE TABLE IF NOT EXISTS spent(hash TEXT PRIMARY KEY, epoch TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS spent_epoch ON spent(epoch);
CREATE TABLE IF NOT EXISTS counters(k TEXT PRIMARY KEY, v INT NOT NULL);
INSERT OR IGNORE INTO counters(k, v) VALUES ('spent_total', 0);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
  raw.exec(SCHEMA);
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  const db = {
    raw,
    get(sql, ...a) { return st(sql).get(...a); },
    all(sql, ...a) { return st(sql).all(...a); },
    run(sql, ...a) { return st(sql).run(...a); },
    /** One synchronous IMMEDIATE transaction; fn must not await. */
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = fn(); raw.exec('COMMIT'); return r; } catch (e) { try { raw.exec('ROLLBACK'); } catch {} throw e; }
    },
    close() { raw.close(); },
  };
  return db;
}
