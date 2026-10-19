const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');

/* Stay & Roam router (PostgreSQL-safe). Mounted at /api by server.js.
 * SAFE migrations only: CREATE TABLE IF NOT EXISTS + ADD COLUMN. No drops. */

function parseArr(v, cap) {
  let a = [];
  try {
    if (Array.isArray(v)) a = v;
    else if (typeof v === 'string' && v.trim()) a = JSON.parse(v);
  } catch (e) { a = []; }
  if (!Array.isArray(a)) a = [];
  return cap ? a.slice(0, cap) : a;
}
function pubProp(r) {
  if (!r) return null;
  const o = { ...r };
  delete o.latitude; delete o.longitude;
  delete o.google_maps_link; delete o.exact_address;
  o.amenities = parseArr(r.amenities, 50);
  o.images = parseArr(r.images, 15);
  return o;
}
function fullProp(r) {
  if (!r) return null;
  const o = { ...r };
  o.amenities = parseArr(r.amenities, 50);
  o.images = parseArr(r.images, 15);
  return o;
}
function pubBook(b) {
  if (!b) return null;
  const o = {
    booking_reference: b.booking_reference,
    payment_status: b.payment_status,
    check_in: b.check_in,
    check_out: b.check_out,
    total_price: b.total_price
  };
  if (String(b.payment_status) === 'paid') o.check_in_pin = b.check_in_pin;
  return o;
}
function genRef() { return 'STAY-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function genPin() {
  try { return String(crypto.randomInt(1000, 10000)); }
  catch (e) { return String(1000 + Math.floor(Math.random() * 9000)); }
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(String(s) + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === String(s);
}
function nights(ci, co) {
  return Math.round((new Date(co + 'T00:00:00Z') - new Date(ci + 'T00:00:00Z')) / 86400000);
}

async function ensureStayTables(deps) {
  const { dbRun, dbAll } = deps;
  await dbRun(`CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, description TEXT DEFAULT '', location TEXT NOT NULL,
    price_per_night REAL NOT NULL DEFAULT 0, max_guests INTEGER DEFAULT 2,
    amenities TEXT DEFAULT '[]', images TEXT DEFAULT '[]',
    latitude REAL, longitude REAL, google_maps_link TEXT, exact_address TEXT,
    is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, user_id INTEGER,
    guest_name TEXT NOT NULL, guest_email TEXT NOT NULL, guest_phone TEXT NOT NULL,
    check_in TEXT NOT NULL, check_out TEXT NOT NULL, total_price REAL NOT NULL DEFAULT 0,
    booking_reference TEXT UNIQUE NOT NULL, payment_status TEXT DEFAULT 'pending',
    check_in_pin TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const cols = async (t) => { try { return await dbAll(`PRAGMA table_info(${t})`); } catch (e) { return []; } };
  const addCol = async (t, n, d) => {
    const c = await cols(t);
    if (!c.some((x) => String(x.name).toLowerCase() === n)) {
      try { await dbRun(`ALTER TABLE ${t} ADD COLUMN ${n} ${d}`); }
      catch (e) { if (!/duplicate|already exists|42701/i.test(e.message || '')) throw e; }
    }
  };
  const pcols = [['description',`TEXT DEFAULT ''`],['location','TEXT'],['price_per_night','REAL DEFAULT 0'],['max_guests','INTEGER DEFAULT 2'],['amenities',`TEXT DEFAULT '[]'`],['images',`TEXT DEFAULT '[]'`],['latitude','REAL'],['longitude','REAL'],['google_maps_link','TEXT'],['exact_address','TEXT'],['is_active','INTEGER DEFAULT 1']];
  for (const [n, d] of pcols) await addCol('properties', n, d);
  const bcols = [['user_id','INTEGER'],['guest_name','TEXT'],['guest_email','TEXT'],['guest_phone','TEXT'],['check_in','TEXT'],['check_out','TEXT'],['total_price','REAL DEFAULT 0'],['booking_reference','TEXT'],['payment_status',`TEXT DEFAULT 'pending'`],['check_in_pin','TEXT']];
  for (const [n, d] of bcols) await addCol('bookings', n, d);
  // Keep legacy markets readable. The market lifecycle migration is deliberately
  // additive; it must not invent closing times or constrain old rows at boot.
  const idx = ['CREATE INDEX IF NOT EXISTS idx_bk_prop ON bookings(property_id, check_in, check_out)','CREATE INDEX IF NOT EXISTS idx_bk_ref ON bookings(booking_reference)','CREATE INDEX IF NOT EXISTS idx_bk_st ON bookings(payment_status)','CREATE INDEX IF NOT EXISTS idx_pr_act ON properties(is_active)','CREATE INDEX IF NOT EXISTS idx_mk_end ON markets(event_end_time)'];
  for (const q of idx) { try { await dbRun(q); } catch (e) {} }
}

let expiryOn = false;
function startExpiry(deps) {
  if (expiryOn) return;
  expiryOn = true;
  const sweep = async () => {
    try { await deps.dbRun(`UPDATE bookings SET payment_status='cancelled' WHERE payment_status='pending' AND created_at < NOW() - INTERVAL '15 minutes'`); }
    catch (e) { console.warn('[stay] expiry sweep failed:', e.message); }
  };
  sweep();
  cron.schedule('*/5 * * * *', sweep);
}


function createStayApiRouter(deps) {
  const router = express.Router();
  const { dbAll, dbGet, dbRun, authenticateAdmin, notifyStayBooking } = deps;
  const say = (type, payload) => {
    try {
      if (typeof notifyStayBooking === 'function')
        Promise.resolve(notifyStayBooking(type, payload)).catch((e) => console.warn('[stay] notify:', e.message));
    } catch (e) { console.warn('[stay] notify:', e.message); }
  };
  startExpiry(deps);

  router.get('/stays', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 60, 120);
      const rows = await dbAll(`SELECT * FROM properties WHERE is_active = 1 ORDER BY created_at DESC LIMIT ?`, [limit]);
      res.json({ success: true, stays: (rows || []).map(pubProp) });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load stays' }); }
  });
  router.get('/stays/count', async (_req, res) => {
    try {
      const r = await dbGet(`SELECT COUNT(*) AS c FROM properties WHERE is_active = 1`);
      res.json({ success: true, count: Number(r && r.c) || 0 });
    } catch (e) { res.status(500).json({ success: false, message: 'Count failed' }); }
  });
  router.get('/stays/booking/:reference', async (req, res) => {
    try {
      const b = await dbGet(`SELECT * FROM bookings WHERE booking_reference = ? LIMIT 1`, [String(req.params.reference || '').trim()]);
      if (!b) return res.status(404).json({ success: false, message: 'Booking not found' });
      const prop = await dbGet(`SELECT * FROM properties WHERE id = ? LIMIT 1`, [b.property_id]);
      if (String(b.payment_status) === 'paid')
        return res.json({ success: true, booking: pubBook(b), property: fullProp(prop) });
      return res.json({ success: true, booking: pubBook(b), property: pubProp(prop) });
    } catch (e) { res.status(500).json({ success: false, message: 'Lookup failed' }); }
  });
  router.get('/stays/:id/availability', async (req, res) => {
    try {
      const ci = String(req.query.check_in || '').slice(0, 10);
      const co = String(req.query.check_out || '').slice(0, 10);
      if (!validDate(ci) || !validDate(co) || nights(ci, co) < 1)
        return res.status(400).json({ success: false, message: 'Invalid dates' });
      const clash = await dbGet(`SELECT id FROM bookings WHERE property_id = ? AND payment_status IN ('paid','pending') AND check_in < ? AND check_out > ? LIMIT 1`, [req.params.id, co, ci]);
      if (clash) return res.json({ success: true, available: false, status: 'BOOKED', message: 'Already booked for selected dates' });
      return res.json({ success: true, available: true, status: 'AVAILABLE' });
    } catch (e) { res.status(500).json({ success: false, message: 'Availability check failed' }); }
  });
  router.get('/stays/:id', async (req, res) => {
    try {
      const row = await dbGet(`SELECT * FROM properties WHERE id = ? LIMIT 1`, [req.params.id]);
      if (!row || Number(row.is_active) !== 1) return res.status(404).json({ success: false, message: 'Stay not found' });
      res.json({ success: true, stay: pubProp(row) });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load stay' }); }
  });

  router.post('/stays/book', async (req, res) => {
    const b = req.body || {};
    const ci = String(b.check_in || '').slice(0, 10);
    const co = String(b.check_out || '').slice(0, 10);
    if (!b.property_id || !b.guest_name || !b.guest_email || !b.guest_phone)
      return res.status(400).json({ success: false, message: 'Name, email, phone and property are required' });
    if (!validDate(ci) || !validDate(co) || nights(ci, co) < 1)
      return res.status(400).json({ success: false, message: 'Invalid check-in/check-out dates' });
    try {
      const out = await deps.withTransaction(async () => {
        const prop = await dbGet(`SELECT * FROM properties WHERE id = ? FOR UPDATE`, [Number(b.property_id)]);
        if (!prop || Number(prop.is_active) !== 1) throw Object.assign(new Error('Property unavailable'), { status: 404 });
        const clash = await dbGet(`SELECT id FROM bookings WHERE property_id = ? AND payment_status IN ('paid','pending') AND check_in < ? AND check_out > ? LIMIT 1 FOR UPDATE`, [prop.id, co, ci]);
        if (clash) throw Object.assign(new Error('Already booked for selected dates'), { status: 409 });
        const n = nights(ci, co);
        const total = Math.round(n * Number(prop.price_per_night || 0) * 100) / 100;
        let ref = null;
        for (let i = 0; i < 5; i++) {
          ref = genRef();
          const inserted = await dbGet(`INSERT INTO bookings (property_id, user_id, guest_name, guest_email, guest_phone, check_in, check_out, total_price, booking_reference, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT (booking_reference) DO NOTHING RETURNING id`,
            [prop.id, null, String(b.guest_name).trim(), String(b.guest_email).trim().toLowerCase(), String(b.guest_phone).trim(), ci, co, total, ref]);
          if (inserted) break;
          ref = null;
        }
        if (!ref) throw Object.assign(new Error('Retry booking'), { status: 500 });
        return { reference: ref, total_price: total, nights: n, property: prop };
      });
      res.json({ success: true, reference: out.reference, total_price: out.total_price, payment_status: 'pending' });
    } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message || 'Booking failed' }); }
  });

  router.get('/admin/stays', authenticateAdmin, async (_req, res) => {
    try {
      const rows = await dbAll(`SELECT * FROM properties ORDER BY created_at DESC`);
      res.json({ success: true, properties: (rows || []).map(fullProp) });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load properties' }); }
  });
  router.get('/admin/properties/:id', authenticateAdmin, async (req, res) => {
    try {
      const property = await dbGet(`SELECT * FROM properties WHERE id = ? LIMIT 1`, [req.params.id]);
      if (!property) return res.status(404).json({ success: false, message: 'Property not found' });
      const finance = await dbGet(`SELECT COUNT(*) AS booking_count, COALESCE(SUM(total_price), 0) AS booked_value, COALESCE(SUM(CASE WHEN LOWER(payment_status) = 'paid' THEN total_price ELSE 0 END), 0) AS paid_revenue, SUM(CASE WHEN LOWER(payment_status) = 'paid' THEN 1 ELSE 0 END) AS paid_count, SUM(CASE WHEN LOWER(payment_status) = 'pending' THEN 1 ELSE 0 END) AS pending_count, SUM(CASE WHEN LOWER(payment_status) = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count FROM bookings WHERE property_id = ?`, [req.params.id]);
      const bookings = await dbAll(`SELECT id, guest_name, guest_email, guest_phone, check_in, check_out, total_price, booking_reference, payment_status, created_at FROM bookings WHERE property_id = ? ORDER BY created_at DESC LIMIT 100`, [req.params.id]);
      res.json({ success: true, property: fullProp(property), finance: finance || {}, bookings: bookings || [] });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load property details' }); }
  });
  router.post('/stays/booking/:reference/pay', async (req, res) => {
    try {
      const booking = await dbGet(`SELECT * FROM bookings WHERE booking_reference = ? LIMIT 1`, [String(req.params.reference || '').trim()]);
      if (!booking || booking.payment_status !== 'pending') return res.status(404).json({ success: false, message: 'Pending booking not found' });
      const phone = String(req.body && req.body.phone || '').replace(/\s+/g, '');
      if (phone !== String(booking.guest_phone || '').replace(/\s+/g, '')) return res.status(403).json({ success: false, message: 'Use the phone number entered for this booking' });
      if (typeof deps.startStayPayment !== 'function') return res.status(503).json({ success: false, message: 'M-Pesa booking payments are not configured' });
      const result = await deps.startStayPayment({ booking });
      res.json({ success: true, ...result });
    } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message || 'Could not start payment' }); }
  });
  router.post('/admin/properties', authenticateAdmin, async (req, res) => {
    try {
      const p = req.body || {};
      if (!p.title || !p.location || !(Number(p.price_per_night) > 0))
        return res.status(400).json({ success: false, message: 'Title, location and price/night required' });
      const na = (v) => (Array.isArray(v) ? v : String(v || '').split(',').map((s) => s.trim()).filter(Boolean));
      const imgs = na(p.images).slice(0, 15);
      if (imgs.some((url) => !/^https:\/\/res\.cloudinary\.com\//i.test(String(url))))
        return res.status(400).json({ success: false, message: 'Property photos must be uploaded to Cloudinary.' });
      const nn = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
      const r = await dbRun(`INSERT INTO properties (title, description, location, price_per_night, max_guests, amenities, images, is_active, latitude, longitude, google_maps_link, exact_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(p.title).trim(), String(p.description || ''), String(p.location).trim(), Number(p.price_per_night), Math.max(1, Number(p.max_guests) || 2), JSON.stringify(na(p.amenities)), JSON.stringify(imgs), Number(p.is_active) === 0 ? 0 : 1, nn(p.latitude), nn(p.longitude), p.google_maps_link ? String(p.google_maps_link) : null, p.exact_address ? String(p.exact_address) : null]);
      res.json({ success: true, id: r && r.lastID != null ? Number(r.lastID) : undefined });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not create property' }); }
  });
  router.get('/admin/bookings', authenticateAdmin, async (_req, res) => {
    try {
      const rows = await dbAll(`SELECT b.*, p.title AS property_title, p.location AS property_location FROM bookings b LEFT JOIN properties p ON p.id = b.property_id ORDER BY b.created_at DESC LIMIT 500`);
      res.json({ success: true, bookings: rows || [] });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load bookings' }); }
  });

  router.patch('/admin/properties/:id', authenticateAdmin, async (req, res) => {
    try {
      const p = req.body || {};
      const sets = [], vals = [];
      const set = (c, v) => { sets.push(c + ' = ?'); vals.push(v); };
      if (p.title != null) set('title', String(p.title));
      if (p.description != null) set('description', String(p.description));
      if (p.location != null) set('location', String(p.location));
      if (p.price_per_night != null) {
        if (!(Number(p.price_per_night) > 0)) return res.status(400).json({ success: false, message: 'Invalid price' });
        set('price_per_night', Number(p.price_per_night));
      }
      if (p.max_guests != null) set('max_guests', Math.max(1, Number(p.max_guests) || 1));
      if (p.amenities != null) set('amenities', JSON.stringify(Array.isArray(p.amenities) ? p.amenities.slice(0, 50) : []));
      if (p.images != null) {
        const images = (Array.isArray(p.images) ? p.images : []).filter(Boolean).slice(0, 15);
        if (images.some((url) => !/^https:\/\/res\.cloudinary\.com\//i.test(String(url))))
          return res.status(400).json({ success: false, message: 'Property photos must be uploaded to Cloudinary.' });
        set('images', JSON.stringify(images));
      }
      if (p.is_active != null) set('is_active', Number(p.is_active) ? 1 : 0);
      for (const k of ['latitude', 'longitude', 'google_maps_link', 'exact_address']) {
        if (p[k] !== undefined) set(k, (p[k] === '' || p[k] == null) ? null : String(p[k]));
      }
      if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
      vals.push(req.params.id);
      await dbRun(`UPDATE properties SET ` + sets.join(', ') + ` WHERE id = ?`, vals);
      res.json({ success: true, id: Number(req.params.id) });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not update property' }); }
  });
  // Keep booking and payment records for accounting, while erasing listing content.
  router.delete('/admin/properties/:id', authenticateAdmin, async (req, res) => {
    try {
      const property = await dbGet(`SELECT id FROM properties WHERE id = ? LIMIT 1`, [req.params.id]);
      if (!property) return res.status(404).json({ success: false, message: 'Property not found' });
      await deps.withTransaction(async () => {
        await dbRun(`UPDATE bookings SET payment_status = 'cancelled' WHERE property_id = ? AND LOWER(payment_status) = 'pending'`, [req.params.id]);
        await dbRun(`UPDATE properties SET title = ?, description = '', location = '', max_guests = 0, amenities = '[]', images = '[]', latitude = NULL, longitude = NULL, google_maps_link = NULL, exact_address = NULL, is_active = 0 WHERE id = ?`, [`Deleted property #${Number(req.params.id)}`, req.params.id]);
      });
      res.json({ success: true, id: Number(req.params.id), archived: true, financeRetained: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not delete property' }); }
  });
  async function applyStatus(id, st) {
    return deps.withTransaction(async () => {
      const ex = await dbGet(`SELECT * FROM bookings WHERE id = ? FOR UPDATE`, [id]);
      if (!ex) throw Object.assign(new Error('Booking not found'), { status: 404 });
      if (st === 'paid') {
        const clash = await dbGet(`SELECT id FROM bookings WHERE property_id = ? AND id <> ? AND payment_status = 'paid' AND check_in < ? AND check_out > ? LIMIT 1 FOR UPDATE`, [ex.property_id, ex.id, ex.check_out, ex.check_in]);
        if (clash) throw Object.assign(new Error('Overlaps a paid booking'), { status: 409 });
        const pin = ex.check_in_pin || genPin();
        try { return await dbGet(`UPDATE bookings SET payment_status='paid', check_in_pin=? WHERE id=? RETURNING *`, [pin, id]); }
        catch (e) { await dbRun(`UPDATE bookings SET payment_status='paid', check_in_pin=? WHERE id=?`, [pin, id]); return dbGet(`SELECT * FROM bookings WHERE id=?`, [id]); }
      }
      try { return await dbGet(`UPDATE bookings SET payment_status=? WHERE id=? RETURNING *`, [st, id]); }
      catch (e) { await dbRun(`UPDATE bookings SET payment_status=? WHERE id=?`, [st, id]); return dbGet(`SELECT * FROM bookings WHERE id=?`, [id]); }
    });
  }
  router.patch('/admin/bookings/:id', authenticateAdmin, async (req, res) => {
    try {
      const st = String((req.body && req.body.payment_status) || '').toLowerCase();
      if (!['paid', 'cancelled', 'pending'].includes(st)) return res.status(400).json({ success: false, message: 'Invalid status' });
      const upd = await applyStatus(req.params.id, st);
      const prop = await dbGet(`SELECT * FROM properties WHERE id = ? LIMIT 1`, [upd.property_id]);
      say(st === 'paid' ? 'booking_paid' : 'booking_status', { reference: upd.booking_reference, property_id: upd.property_id, property_title: prop && prop.title, guest_name: upd.guest_name, guest_email: upd.guest_email, guest_phone: upd.guest_phone, check_in: upd.check_in, check_out: upd.check_out, total_price: upd.total_price, payment_status: upd.payment_status, check_in_pin: upd.check_in_pin, google_maps_link: prop && prop.google_maps_link, exact_address: prop && prop.exact_address });
      res.json({ success: true, booking: upd });
    } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message || 'Update failed' }); }
  });
  router.post('/admin/bookings/:id/verify-pin', authenticateAdmin, async (req, res) => {
    try {
      const b = await dbGet(`SELECT * FROM bookings WHERE id = ? LIMIT 1`, [req.params.id]);
      if (!b) return res.status(404).json({ success: false, message: 'Booking not found' });
      const ok = String((req.body && req.body.pin) || '').trim() === String(b.check_in_pin || '');
      res.json({ success: true, valid: ok && String(b.payment_status) === 'paid' });
    } catch (e) { res.status(500).json({ success: false, message: 'Verify failed' }); }
  });

  return router;
}

module.exports = { createStayApiRouter, ensureStayTables };
