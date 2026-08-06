// Tgahw (تَقْهوَّ) — QR desk ordering service
// Run: node server.js  →  http://localhost:3000

const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const DB = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

const MENU_FILE = path.join(__dirname, 'menu.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DESKS_FILE = path.join(__dirname, 'desks.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- config file helpers (menu / desks / settings stay as JSON) ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

const loadMenu = () => readJSON(MENU_FILE, { categories: [] });
const loadDesks = () => readJSON(DESKS_FILE, { desks: [] }).desks;
function deskByToken(tok) { return loadDesks().find(d => d.token === tok); }
// Resolve a desk from either a token (?t=) or, as a fallback, a raw desk id.
function resolveDesk(req) {
  const tok = req.query.t || (req.body && req.body.t);
  if (tok) return deskByToken(tok);
  const id = req.query.desk || (req.body && req.body.desk);
  if (id) return loadDesks().find(d => d.id === id);
  return null;
}
const saveDesks = d => writeJSON(DESKS_FILE, { desks: d });
function deskFloor(id) { const m = String(id).match(/^(\d+F)/); return m ? m[1] : null; }

const DEFAULT_SETTINGS = {
  paused: false,
  pauseMessage: '',
  workingHours: { enabled: false, start: '07:30', end: '17:00' },
  avgPrepMinutes: 4,
  outOfStock: []   // list of item ids the pantry has temporarily marked out
};
const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_FILE, {}) });

function isWithinWorkingHours(s) {
  if (!s.workingHours.enabled) return true;
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = s.workingHours.start.split(':').map(Number);
  const [eh, em] = s.workingHours.end.split(':').map(Number);
  return hm >= sh * 60 + sm && hm < eh * 60 + em;
}
function serviceStatus() {
  const s = loadSettings();
  const withinHours = isWithinWorkingHours(s);
  const open = !s.paused && withinHours;
  let reason = null;
  if (s.paused) reason = 'paused';
  else if (!withinHours) reason = 'closed';
  return { open, reason, pauseMessage: s.pauseMessage || '', workingHours: s.workingHours, avgPrepMinutes: s.avgPrepMinutes || 4 };
}
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-pin'] === ADMIN_PIN) return next();
  res.status(401).json({ error: 'Wrong PIN.' });
}
function openQueueSize(floor) {
  if (floor) return DB.get(`SELECT COUNT(*) n FROM orders WHERE status='open' AND floor=?`, [floor]).n;
  return DB.get(`SELECT COUNT(*) n FROM orders WHERE status='open'`).n;
}
function estimatedWaitMinutes() {
  const s = loadSettings();
  return Math.max(1, openQueueSize() * (s.avgPrepMinutes || 4));
}

// ---------- public API ----------

app.get('/api/status', (req, res) => {
  const st = serviceStatus();
  res.json({ ...st, queue: openQueueSize(), estWait: estimatedWaitMinutes() });
});

// Resolve a scanned token (or id) to the desk's public info
app.get('/api/desk', (req, res) => {
  const d = resolveDesk(req);
  if (!d) return res.status(404).json({ error: 'unknown_desk' });
  if (d.active === false) return res.status(423).json({ error: 'desk_inactive' });
  // The "call the pantry" button shows for meeting rooms, or any desk an admin flagged with allowCall
  const canCall = d.type === 'room' || d.allowCall === true;
  res.json({ id: d.id, type: d.type || 'desk', isRoom: d.type === 'room', canCall, floor: deskFloor(d.id), maxQty: d.maxQty || 5 });
});

// A meeting room requests the pantry. kind: service | refill | clear | other
app.post('/api/calls', (req, res) => {
  const d = resolveDesk(req);
  if (!d) return res.status(400).json({ error: 'unknown_desk' });
  // allow meeting rooms, or any desk an admin flagged with allowCall
  if (d.type !== 'room' && d.allowCall !== true) return res.status(403).json({ error: 'not_allowed' });
  const kind = String((req.body || {}).kind || 'service');
  if (!['service', 'refill', 'clear', 'other'].includes(kind)) return res.status(400).json({ error: 'bad_kind' });
  const message = req.body && req.body.message ? String(req.body.message).slice(0, 160) : null;
  // avoid stacking: one open call of the same kind per room
  const existing = DB.get(`SELECT id FROM calls WHERE desk=? AND kind=? AND status='open'`, [d.id, kind]);
  if (existing) return res.json({ ok: true, deduped: true });
  const call = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    desk: d.id, floor: deskFloor(d.id), kind, message, status: 'open', createdAt: new Date().toISOString()
  };
  DB.run(`INSERT INTO calls (id,desk,floor,kind,message,status,createdAt,resolvedAt) VALUES (?,?,?,?,?,?,?,?)`,
    [call.id, call.desk, call.floor, call.kind, call.message, 'open', call.createdAt, null]);
  res.status(201).json({ ok: true });
});

// Open room calls (pantry screen)
app.get('/api/calls/open', (req, res) => {
  const floor = req.query.floor;
  let sql = `SELECT * FROM calls WHERE status='open'`;
  const params = [];
  if (floor && floor !== 'all') { sql += ` AND floor=?`; params.push(floor); }
  sql += ` ORDER BY createdAt ASC`;
  res.json(DB.rows(sql, params));
});
app.post('/api/calls/:id/resolve', (req, res) => {
  DB.run(`UPDATE calls SET status='resolved', resolvedAt=? WHERE id=?`, [new Date().toISOString(), req.params.id]);
  res.json({ ok: true });
});

app.get('/api/menu', (req, res) => {
  const menu = loadMenu();
  const oos = new Set(loadSettings().outOfStock || []);
  // Ordering page: only items that are available AND in stock
  menu.categories.forEach(c => { c.items = c.items.filter(i => i.available && !oos.has(i.id)); });
  res.json(menu);
});

// Full menu with an inStock flag — used by the pantry screen to toggle stock
app.get('/api/menu/stock', (req, res) => {
  const menu = loadMenu();
  const oos = new Set(loadSettings().outOfStock || []);
  const items = [];
  menu.categories.forEach(c => c.items.forEach(i => {
    if (i.available) items.push({ id: i.id, name: i.name, name_ar: i.name_ar, category: c.name, inStock: !oos.has(i.id) });
  }));
  res.json(items);
});

// Pantry toggles an item's stock
app.post('/api/stock/toggle', (req, res) => {
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId required.' });
  const s = loadSettings();
  const oos = new Set(s.outOfStock || []);
  if (oos.has(itemId)) oos.delete(itemId); else oos.add(itemId);
  s.outOfStock = [...oos];
  writeJSON(SETTINGS_FILE, s);
  res.json({ itemId, inStock: !oos.has(itemId) });
});

// Place an order
app.post('/api/orders', (req, res) => {
  const st = serviceStatus();
  if (!st.open) return res.status(423).json({ error: 'service_closed', reason: st.reason, pauseMessage: st.pauseMessage, workingHours: st.workingHours });

  const { item, option, note, qty, itemId } = req.body || {};
  // Desk comes from a token (preferred) or a raw id (fallback)
  const deskDef = resolveDesk(req);
  if (!deskDef) return res.status(400).json({ error: 'unknown_desk' });
  if (deskDef.active === false) return res.status(423).json({ error: 'desk_inactive' });
  const desk = deskDef.id;

  if (!item) return res.status(400).json({ error: 'Item is required.' });

  // Reject out-of-stock items
  if (itemId && (loadSettings().outOfStock || []).includes(itemId)) {
    return res.status(409).json({ error: 'out_of_stock' });
  }

  const maxForDesk = deskDef.maxQty || 5;
  const quantity = Math.max(1, Math.min(maxForDesk, parseInt(qty, 10) || 1));

  if (String(item).length > 60 || String(note || '').length > 120 || String(option || '').length > 120) {
    return res.status(400).json({ error: 'Input too long.' });
  }

  // Duplicate guard: same desk + same item within 2 minutes
  const dupWindow = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const dup = DB.get(`SELECT COUNT(*) n FROM orders WHERE desk=? AND item=? AND createdAt>=?`, [desk, String(item), dupWindow]).n;
  if (dup > 0 && !(req.body && req.body.confirmDup)) {
    return res.status(409).json({ error: 'possible_duplicate' });
  }

  // Pending-order cap prevents spam but must allow a cart of drinks.
  // Meeting rooms serve groups, so they get a higher cap than desks.
  const isRoom = deskDef.type === 'room';
  const pendingCap = isRoom ? 25 : 10;
  const openForDesk = DB.get(`SELECT COUNT(*) n FROM orders WHERE desk=? AND status='open'`, [desk]).n;
  if (openForDesk >= pendingCap) return res.status(429).json({ error: `This desk already has ${pendingCap} pending orders. Please wait for them to arrive.` });

  const deskFl = deskFloor(desk);
  const position = openQueueSize(deskFl) + 1;
  const order = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    desk: String(desk), floor: deskFl,
    item: String(item), option: option ? String(option) : null, note: note ? String(note) : null,
    qty: quantity, status: 'open', feedback: null,
    createdAt: new Date().toISOString(), doneAt: null
  };
  DB.run(`INSERT INTO orders (id,desk,floor,item,option,note,qty,status,feedback,createdAt,doneAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [order.id, order.desk, order.floor, order.item, order.option, order.note, order.qty, 'open', null, order.createdAt, null]);

  res.status(201).json({ ...order, position, estWait: position * (loadSettings().avgPrepMinutes || 4) });
});

// Recent orders for the scanned desk — MUST be before /api/orders/:id
// so Express doesn't treat "recent" as an order id.
app.get('/api/orders/recent', (req, res) => {
  const d = resolveDesk(req);
  if (!d) return res.json([]);
  const list = DB.rows(`SELECT id,item,option,note,qty,status,createdAt FROM orders WHERE desk=? ORDER BY createdAt DESC LIMIT 5`, [d.id]);
  res.json(list);
});

// The desk's most-ordered drink (favorite) — also before /api/orders/:id
app.get('/api/orders/favorite', (req, res) => {
  const d = resolveDesk(req);
  if (!d) return res.json(null);
  const fav = DB.get(`SELECT item, SUM(qty) n FROM orders WHERE desk=? GROUP BY item ORDER BY n DESC LIMIT 1`, [d.id]);
  res.json(fav || null);
});

// Track one order
app.get('/api/orders/:id', (req, res) => {
  const order = DB.get(`SELECT * FROM orders WHERE id=?`, [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  let position = null;
  if (order.status === 'open') {
    position = DB.get(`SELECT COUNT(*) n FROM orders WHERE status='open' AND floor=? AND createdAt<=?`, [order.floor, order.createdAt]).n;
  }
  res.json({ ...order, position });
});

app.post('/api/orders/:id/feedback', (req, res) => {
  const order = DB.get(`SELECT id FROM orders WHERE id=?`, [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  DB.run(`UPDATE orders SET feedback='up' WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
});

// Recent orders for the scanned desk (so the escalation form can attach to one)
// ---------- escalations ----------
app.post('/api/escalations', (req, res) => {
  const { orderId, category, message } = req.body || {};
  const d = resolveDesk(req);
  if (!d) return res.status(400).json({ error: 'unknown_desk' });
  const desk = d.id;
  if (!category) return res.status(400).json({ error: 'Category is required.' });
  const validCats = ['late', 'wrong', 'quality', 'missing'];
  if (!validCats.includes(category)) return res.status(400).json({ error: 'Invalid category.' });
  if (String(message || '').length > 200) return res.status(400).json({ error: 'Message too long.' });

  let orderText = null;
  if (orderId) {
    const o = DB.get(`SELECT item,option,qty,status FROM orders WHERE id=?`, [orderId]);
    if (o) orderText = `${o.qty > 1 ? o.qty + '× ' : ''}${o.item}${o.option ? ' · ' + o.option : ''} · ${o.status}`;
  }
  const esc = {
    id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    desk: String(desk), floor: deskFloor(desk), orderId: orderId || null, orderText,
    category, message: message ? String(message) : null, status: 'open', createdAt: new Date().toISOString()
  };
  DB.run(`INSERT INTO escalations (id,desk,floor,orderId,orderText,category,message,status,createdAt,resolvedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [esc.id, esc.desk, esc.floor, esc.orderId, esc.orderText, esc.category, esc.message, 'open', esc.createdAt, null]);
  res.status(201).json({ ok: true });
});

// ---------- staff API ----------
app.get('/api/orders/queue/open', (req, res) => {
  const floor = req.query.floor;
  let sql = `SELECT * FROM orders WHERE status='open'`;
  const params = [];
  if (floor && floor !== 'all') { sql += ` AND floor=?`; params.push(floor); }
  sql += ` ORDER BY createdAt ASC`;
  res.json(DB.rows(sql, params));
});

app.get('/api/floors', (req, res) => {
  const floors = [...new Set(loadDesks().map(d => deskFloor(d.id)).filter(Boolean))].sort();
  res.json(floors);
});

app.post('/api/orders/:id/done', (req, res) => {
  const order = DB.get(`SELECT id FROM orders WHERE id=?`, [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  DB.run(`UPDATE orders SET status='done', doneAt=? WHERE id=?`, [new Date().toISOString(), req.params.id]);
  res.json({ ok: true });
});

// Undo a delivered order (staff misclick) — reopens it
app.post('/api/orders/:id/undo', (req, res) => {
  const order = DB.get(`SELECT id FROM orders WHERE id=?`, [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  DB.run(`UPDATE orders SET status='open', doneAt=NULL WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/orders/stats/today', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const floor = req.query.floor && req.query.floor !== 'all' ? String(req.query.floor) : null;
  const where = floor ? `substr(createdAt,1,10)=? AND floor=?` : `substr(createdAt,1,10)=?`;
  const args = floor ? [today, floor] : [today];
  const r = DB.get(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN feedback='up' THEN 1 ELSE 0 END) thumbsUp
    FROM orders WHERE ${where}`, args);
  const escWhere = floor ? `status='open' AND floor=?` : `status='open'`;
  const openEsc = DB.get(`SELECT COUNT(*) n FROM escalations WHERE ${escWhere}`, floor ? [floor] : []).n;
  res.json({ total: r.total || 0, done: r.done || 0, thumbsUp: r.thumbsUp || 0, openEscalations: openEsc });
});

app.post('/api/staff/pause', (req, res) => {
  const s = loadSettings();
  s.paused = !!req.body.paused;
  s.pauseMessage = req.body.pauseMessage ? String(req.body.pauseMessage).slice(0, 120) : '';
  writeJSON(SETTINGS_FILE, s);
  res.json(serviceStatus());
});

// Open escalations for the staff/admin view
app.get('/api/escalations/open', (req, res) => {
  res.json(DB.rows(`SELECT * FROM escalations WHERE status='open' ORDER BY createdAt ASC`));
});
app.post('/api/escalations/:id/resolve', (req, res) => {
  DB.run(`UPDATE escalations SET status='resolved', resolvedAt=? WHERE id=?`, [new Date().toISOString(), req.params.id]);
  res.json({ ok: true });
});

// ---------- admin API ----------
app.post('/api/admin/login', (req, res) => {
  if ((req.body || {}).pin === ADMIN_PIN) return res.json({ ok: true });
  res.status(401).json({ error: 'Wrong PIN.' });
});

// Dashboard aggregates. range = today | week | month | year
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const range = req.query.range || 'today';
  const floor = req.query.floor && req.query.floor !== 'all' ? String(req.query.floor) : null;
  const now = new Date();
  let since = new Date();
  if (range === 'today') since = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  else if (range === 'week') since.setDate(now.getDate() - 7);
  else if (range === 'month') since.setMonth(now.getMonth() - 1);
  else if (range === 'year') since.setFullYear(now.getFullYear() - 1);
  const sinceISO = since.toISOString();

  // base WHERE clause; optionally scoped to one floor
  const base = floor ? `FROM orders WHERE createdAt>=? AND floor=?` : `FROM orders WHERE createdAt>=?`;
  const args = floor ? [sinceISO, floor] : [sinceISO];

  const totals = DB.get(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN feedback='up' THEN 1 ELSE 0 END) thumbsUp,
      SUM(qty) drinks ${base}`, args);

  const byDrink = DB.rows(`SELECT item, SUM(qty) n ${base} GROUP BY item ORDER BY n DESC LIMIT 8`, args);
  const byFloor = DB.rows(`SELECT floor, COUNT(*) n ${base} AND floor IS NOT NULL GROUP BY floor ORDER BY n DESC`, args);
  const byDesk = DB.rows(`SELECT desk, COUNT(*) n ${base} GROUP BY desk ORDER BY n DESC LIMIT 6`, args);
  const byHourRaw = DB.rows(`SELECT substr(createdAt,12,2) hh, COUNT(*) n ${base} GROUP BY hh ORDER BY hh`, args);

  const waitRows = DB.rows(`SELECT createdAt, doneAt ${base} AND doneAt IS NOT NULL`, args);
  let avgWait = null;
  if (waitRows.length) {
    const mins = waitRows.map(r => (new Date(r.doneAt) - new Date(r.createdAt)) / 60000);
    avgWait = Math.round((mins.reduce((a, b) => a + b, 0) / mins.length) * 10) / 10;
  }

  // escalations, optionally scoped to floor
  const escBase = floor ? `WHERE createdAt>=? AND floor=?` : `WHERE createdAt>=?`;
  const escOpen = DB.get(`SELECT COUNT(*) n FROM escalations ${escBase} AND status='open'`, args).n;
  const escTotal = DB.get(`SELECT COUNT(*) n FROM escalations ${escBase}`, args).n;

  res.json({
    range, floor: floor || 'all',
    totals: { total: totals.total || 0, done: totals.done || 0, thumbsUp: totals.thumbsUp || 0, drinks: totals.drinks || 0 },
    avgWait, escalations: { open: escOpen, total: escTotal },
    byDrink, byFloor, byDesk, byHour: byHourRaw
  });
});

// Download dashboard statistics as a CSV file
app.get('/api/admin/dashboard/export', requireAdmin, (req, res) => {
  const range = req.query.range || 'today';
  const floor = req.query.floor && req.query.floor !== 'all' ? String(req.query.floor) : null;
  const now = new Date();
  let since = new Date();
  if (range === 'today') since = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  else if (range === 'week') since.setDate(now.getDate() - 7);
  else if (range === 'month') since.setMonth(now.getMonth() - 1);
  else if (range === 'year') since.setFullYear(now.getFullYear() - 1);
  const sinceISO = since.toISOString();
  const base = floor ? `FROM orders WHERE createdAt>=? AND floor=?` : `FROM orders WHERE createdAt>=?`;
  const args = floor ? [sinceISO, floor] : [sinceISO];

  const totals = DB.get(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN feedback='up' THEN 1 ELSE 0 END) thumbsUp,
      SUM(qty) drinks ${base}`, args);
  const byDrink = DB.rows(`SELECT item, SUM(qty) n ${base} GROUP BY item ORDER BY n DESC`, args);
  const byFloor = DB.rows(`SELECT floor, COUNT(*) n ${base} AND floor IS NOT NULL GROUP BY floor ORDER BY n DESC`, args);
  const byDesk = DB.rows(`SELECT desk, COUNT(*) n ${base} GROUP BY desk ORDER BY n DESC`, args);
  const byHour = DB.rows(`SELECT substr(createdAt,12,2) hh, COUNT(*) n ${base} GROUP BY hh ORDER BY hh`, args);

  const esc = c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`;
  const lines = [];
  lines.push(`تَقْهوَّ — Statistics export`);
  lines.push(`Range,${range}`);
  lines.push(`Floor,${floor || 'All floors'}`);
  lines.push(`Generated,${new Date().toISOString()}`);
  lines.push('');
  lines.push('Summary');
  lines.push('Metric,Value');
  lines.push(`Total orders,${totals.total || 0}`);
  lines.push(`Delivered,${totals.done || 0}`);
  lines.push(`Drinks made,${totals.drinks || 0}`);
  lines.push(`Thumbs up,${totals.thumbsUp || 0}`);
  lines.push('');
  lines.push('Orders by drink');
  lines.push('Drink,Count');
  byDrink.forEach(r => lines.push(`${esc(r.item)},${r.n}`));
  lines.push('');
  lines.push('Orders by floor');
  lines.push('Floor,Count');
  byFloor.forEach(r => lines.push(`${esc(r.floor)},${r.n}`));
  lines.push('');
  lines.push('Orders by desk');
  lines.push('Desk,Count');
  byDesk.forEach(r => lines.push(`${esc(r.desk)},${r.n}`));
  lines.push('');
  lines.push('Orders by hour');
  lines.push('Hour,Count');
  byHour.forEach(r => lines.push(`${esc(r.hh + ':00')},${r.n}`));

  const csv = '\uFEFF' + lines.join('\r\n');  // BOM so Excel reads Arabic correctly
  const stamp = new Date().toISOString().slice(0, 10);
  const fname = `tgahw-stats-${floor || 'all'}-${range}-${stamp}.csv`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
});

app.get('/api/admin/escalations', requireAdmin, (req, res) => {
  res.json(DB.rows(`SELECT * FROM escalations ORDER BY (status='open') DESC, createdAt DESC LIMIT 100`));
});

app.get('/api/admin/desks', requireAdmin, (req, res) => res.json(loadDesks()));
app.post('/api/admin/desks', requireAdmin, (req, res) => {
  const { id, type } = req.body || {};
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'Invalid desk ID.' });
  const desks = loadDesks();
  if (desks.find(d => d.id === id)) return res.status(409).json({ error: 'That desk already exists.' });
  const isRoom = type === 'room';
  desks.push({ id, type: isRoom ? 'room' : 'desk', floor: deskFloor(id), zone: (id.split('-')[1] || null), maxQty: isRoom ? 15 : 5, active: true });
  saveDesks(desks);
  res.status(201).json({ ok: true });
});
app.post('/api/admin/desks/:id/toggle', requireAdmin, (req, res) => {
  const desks = loadDesks();
  const d = desks.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Desk not found.' });
  d.active = !d.active;
  saveDesks(desks);
  res.json(d);
});

// Toggle whether a desk shows the "call the pantry" button (rooms always show it)
app.post('/api/admin/desks/:id/call-toggle', requireAdmin, (req, res) => {
  const desks = loadDesks();
  const d = desks.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Desk not found.' });
  d.allowCall = !d.allowCall;
  saveDesks(desks);
  res.json(d);
});

// Generate a QR code (data URL) for a desk. baseUrl comes from the query so the
// QR points at whatever address the admin is using to reach the server.
app.get('/api/admin/desks/:id/qr', requireAdmin, async (req, res) => {
  const desk = loadDesks().find(d => d.id === req.params.id);
  if (!desk) return res.status(404).json({ error: 'Desk not found.' });
  // base: explicit ?base=... , else derive from the request host
  let base = req.query.base;
  if (!base) base = `${req.protocol}://${req.get('host')}`;
  base = String(base).replace(/\/+$/, '');
  const url = `${base}/order?t=${encodeURIComponent(desk.token)}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: '#003C32', light: '#FFFFFF' } });
    res.json({ id: desk.id, url, dataUrl });
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed.' });
  }
});

app.get('/api/admin/menu', requireAdmin, (req, res) => res.json(loadMenu()));
app.put('/api/admin/menu', requireAdmin, (req, res) => {
  const menu = req.body;
  if (!menu || !Array.isArray(menu.categories)) return res.status(400).json({ error: 'Invalid menu format.' });
  writeJSON(MENU_FILE, menu);
  res.json({ ok: true });
});

// ---- category management ----
function slugId(s) { return 'cat-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).slice(2, 5); }

app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const { name, name_ar } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required.' });
  const menu = loadMenu();
  menu.categories.push({ id: slugId(name), name: String(name).trim(), name_ar: String(name_ar || '').trim(), items: [] });
  writeJSON(MENU_FILE, menu);
  res.status(201).json({ ok: true });
});

app.put('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const menu = loadMenu();
  const cat = menu.categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found.' });
  const { name, name_ar } = req.body || {};
  if (name && String(name).trim()) cat.name = String(name).trim();
  if (typeof name_ar === 'string') cat.name_ar = name_ar.trim();
  writeJSON(MENU_FILE, menu);
  res.json({ ok: true });
});

app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const menu = loadMenu();
  const cat = menu.categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found.' });
  if (cat.items && cat.items.length) return res.status(409).json({ error: 'has_items' });
  menu.categories = menu.categories.filter(c => c.id !== req.params.id);
  writeJSON(MENU_FILE, menu);
  res.json({ ok: true });
});

app.post('/api/admin/categories/reorder', requireAdmin, (req, res) => {
  const order = (req.body || {}).order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of ids.' });
  const menu = loadMenu();
  menu.categories.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  writeJSON(MENU_FILE, menu);
  res.json({ ok: true });
});

// ---- backup: download the SQLite database file ----
app.get('/api/admin/backup', requireAdmin, (req, res) => {
  if (!fs.existsSync(DB.dbFile)) return res.status(404).json({ error: 'No database file yet.' });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="tgahw-backup-${stamp}.sqlite"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(DB.dbFile).pipe(res);
});

app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(loadSettings()));
app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const cur = loadSettings();
  const b = req.body || {};
  const next = {
    paused: typeof b.paused === 'boolean' ? b.paused : cur.paused,
    pauseMessage: typeof b.pauseMessage === 'string' ? b.pauseMessage.slice(0, 120) : cur.pauseMessage,
    workingHours: {
      enabled: !!(b.workingHours && b.workingHours.enabled),
      start: (b.workingHours && b.workingHours.start) || cur.workingHours.start,
      end: (b.workingHours && b.workingHours.end) || cur.workingHours.end
    },
    avgPrepMinutes: Number.isFinite(b.avgPrepMinutes) ? Math.max(1, Math.min(30, b.avgPrepMinutes)) : cur.avgPrepMinutes
  };
  writeJSON(SETTINGS_FILE, next);
  res.json(next);
});

// ---------- pages ----------
app.get('/order', (req, res) => res.sendFile(path.join(__dirname, 'public', 'order.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.redirect('/staff'));

// ---------- boot ----------
DB.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Tgahw running on http://localhost:${PORT}`);
    console.log(`  Order page:   opened by scanning a desk QR (token-based)`);
    console.log(`  Staff screen: /staff`);
    console.log(`  Admin page:   /admin`);
  });
}).catch(err => {
  console.error('Failed to start — database init error:', err);
  process.exit(1);
});
