// db.js — SQLite storage with automatic driver selection.
//
// Prefers Node's built-in SQLite (node:sqlite, Node 22.5+) which writes each
// change straight to disk. If unavailable, falls back to sql.js (WASM), which
// works on any Node version and writes to disk shortly after each change.
//
// Either way the data lives in data.sqlite and survives restarts.

const fs = require('fs');
const path = require('path');
const DB_FILE = path.join(__dirname, 'data.sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, desk TEXT NOT NULL, floor TEXT,
    item TEXT NOT NULL, option TEXT, note TEXT, qty INTEGER DEFAULT 1,
    status TEXT DEFAULT 'open', feedback TEXT,
    createdAt TEXT NOT NULL, doneAt TEXT
  );
  CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY, desk TEXT NOT NULL, floor TEXT,
    orderId TEXT, orderText TEXT, category TEXT NOT NULL, message TEXT,
    status TEXT DEFAULT 'open', createdAt TEXT NOT NULL, resolvedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY, desk TEXT NOT NULL, floor TEXT,
    kind TEXT NOT NULL, message TEXT,
    status TEXT DEFAULT 'open', createdAt TEXT NOT NULL, resolvedAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(createdAt);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
`;

let impl = null;   // { rows, run, get, export }
let driver = 'unknown';

// ---- driver A: built-in node:sqlite (Node 22.5+) ----
function tryNativeDriver() {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch { return null; }
  try {
    const db = new DatabaseSync(DB_FILE);
    db.exec(SCHEMA);
    return {
      rows: (sql, params = []) => db.prepare(sql).all(...params),
      get: (sql, params = []) => db.prepare(sql).get(...params) || null,
      run: (sql, params = []) => { db.prepare(sql).run(...params); },
      exportToDisk: () => {}  // native writes immediately
    };
  } catch (e) {
    return null;
  }
}

// ---- driver B: sql.js (WASM, any Node) ----
async function tryWasmDriver() {
  let initSqlJs;
  try { initSqlJs = require('sql.js'); }
  catch { return null; }
  const SQL = await initSqlJs();
  const db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  db.run(SCHEMA);

  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(DB_FILE, Buffer.from(db.export())); } catch (e) { console.error('DB save error', e); }
    }, 120);
  };
  persist();

  const rows = (sql, params = []) => {
    const stmt = db.prepare(sql); stmt.bind(params);
    const out = []; while (stmt.step()) out.push(stmt.getAsObject()); stmt.free();
    return out;
  };
  return {
    rows,
    get: (sql, params = []) => rows(sql, params)[0] || null,
    run: (sql, params = []) => { const s = db.prepare(sql); s.bind(params); s.step(); s.free(); persist(); },
    exportToDisk: persist
  };
}

async function init() {
  const native = tryNativeDriver();
  if (native) { impl = native; driver = 'node:sqlite (built-in)'; }
  else {
    const wasm = await tryWasmDriver();
    if (!wasm) throw new Error('No SQLite driver available (need Node 22.5+ or the sql.js package).');
    impl = wasm; driver = 'sql.js (WASM fallback)';
  }
  console.log(`  Database:     SQLite via ${driver}`);
  return impl;
}

module.exports = {
  init,
  rows: (...a) => impl.rows(...a),
  get: (...a) => impl.get(...a),
  run: (...a) => impl.run(...a),
  driver: () => driver,
  dbFile: DB_FILE
};
