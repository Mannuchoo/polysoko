const express = require('express');

/* Stay BnB isolated module. CREATE TABLE IF NOT EXISTS only. No DROP/ALTER. */
const STAY_TABLE_DDL = [
  'CREATE TABLE IF NOT EXISTS properties (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, location TEXT NOT NULL, price_per_night REAL NOT NULL, max_guests INTEGER DEFAULT 2, amenities TEXT, images TEXT, is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
  'CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, user_id INTEGER NULL, guest_name TEXT NOT NULL, guest_email TEXT NOT NULL, guest_phone TEXT NOT NULL, check_in DATE NOT NULL, check_out DATE NOT NULL, total_price REAL NOT NULL, booking_reference TEXT UNIQUE NOT NULL, payment_status TEXT DEFAULT \'pending\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
];

const SEED_PROPERTIES = [
  { title: 'Nyali Beachfront Apartment', description: '2BR ocean-view apartment, 3 min walk to City Mall Nyali. Fast WiFi, backup generator.', location: 'Nyali, Mombasa', price_per_night: 6500, max_guests: 5, amenities: '["WiFi","AC","Pool","Generator","Parking","Kitchen","Smart TV"]', images: '["https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800&q=80"]', is_active: 1 },
  { title: 'Kilimani Executive Studio', description: 'Modern studio in Kilimani with high-speed WiFi and 24/7 security.', location: 'Kilimani, Nairobi', price_per_night: 4500, max_guests: 2, amenities: '["WiFi","AC","Generator","Parking","Kitchen","Workspace"]', images: '["https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&q=80"]', is_active: 1 },
  { title: 'Diani Palm Villa', description: 'Private 3BR villa with plunge pool, 5 min to Diani Beach.', location: 'Diani, Kwale', price_per_night: 12000, max_guests: 8, amenities: '["WiFi","Pool","Parking","Kitchen","Chef","Garden","Beach Access"]', images: '["https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=800&q=80"]', is_active: 1 },
];

async function ensureStayTables(deps) {
  const dbRun = deps.dbRun;
  const dbGet = deps.dbGet;
  for (const ddl of STAY_TABLE_DDL) { await dbRun(ddl); }
  try {
    const row = await dbGet('SELECT COUNT(*) AS count FROM properties');
    const count = Number((row && row.count) || 0);
    if (count === 0) {
      for (const p of SEED_PROPERTIES) {
        await dbRun('INSERT INTO properties (title, description, location, price_per_night, max_guests, amenities, images, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [p.title, p.description, p.location, p.price_per_night, p.max_guests, p.amenities, p.images, p.is_active]);
      }
      console.log('Stay BnB: seeded 3 sample properties (table was empty).');
    }
  } catch (e) { console.warn('[stay] seed check skipped:', e.message); }
  console.log('Stay BnB tables ready (properties, bookings).');
}

function safeJsonArray(raw, fallback) {
  const fb = fallback || [];
  if (Array.isArray(raw)) return raw;
  if (!raw) return fb;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : fb; }
  catch (e) { return String(raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
}

function serializeProperty(row) {
  if (!row) return null;
  return { id: row.id, title: row.title, description: row.description, location: row.location, price_per_night: Number(row.price_per_night || 0), max_guests: Number(row.max_guests || 2), amenities: safeJsonArray(row.amenities), images: safeJsonArray(row.images), is_active: Number(row.is_active) === 1 ? 1 : 0, created_at: row.created_at };
}

function genReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return 'STAY-' + code;
}

function nightsBetween(checkIn, checkOut) {
  const a = new Date(checkIn + 'T00:00:00Z');
  const b = new Date(checkOut + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function stayAdminFallback(req, res) { return res.status(500).json({ success: false, message: 'Admin auth missing' }); }

module.exports.STAY_TABLE_DDL = STAY_TABLE_DDL;
module.exports.ensureStayTables = ensureStayTables;
module.exports.safeJsonArray = safeJsonArray;
module.exports.serializeProperty = serializeProperty;
module.exports.genReference = genReference;
module.exports.nightsBetween = nightsBetween;

function createStayApiRouter(deps) {
  const router = express.Router();
  const dbAll = deps.dbAll;
  const dbGet = deps.dbGet;
  const dbRun = deps.dbRun;
  const requireAdmin = deps.authenticateAdmin || stayAdminFallback;

  router.get('/stays', async function (req, res) {
    try {
      const rows = await dbAll('SELECT * FROM properties WHERE is_active = 1 ORDER BY created_at DESC, id DESC');
      res.json({ success: true, stays: (rows || []).map(serializeProperty) });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load stays' }); }
  });

  router.get('/stays/:id', async function (req, res) {
    try {
      const row = await dbGet('SELECT * FROM properties WHERE id = ? LIMIT 1', [req.params.id]);
      if (!row) return res.status(404).json({ success: false, message: 'Property not found' });
      res.json({ success: true, stay: serializeProperty(row) });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load property' }); }
  });

  router.post('/stays/book', async function (req, res) {
    try {
      const b = req.body || {};
      if (!b.property_id) return res.status(400).json({ success: false, message: 'property_id required' });
      if (!b.guest_name || !String(b.guest_name).trim()) return res.status(400).json({ success: false, message: 'Full name required' });
      if (!b.guest_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.guest_email).trim())) return res.status(400).json({ success: false, message: 'Valid email required' });
      if (!b.guest_phone || !String(b.guest_phone).trim()) return res.status(400).json({ success: false, message: 'Phone required' });
      if (!b.check_in || !b.check_out) return res.status(400).json({ success: false, message: 'Dates required' });
      const ci = String(b.check_in).slice(0, 10);
      const co = String(b.check_out).slice(0, 10);
      const nights = nightsBetween(ci, co);
      if (!nights || nights <= 0) return res.status(400).json({ success: false, message: 'check_out must be after check_in' });
      const prop = await dbGet('SELECT * FROM properties WHERE id = ? LIMIT 1', [b.property_id]);
      if (!prop || Number(prop.is_active) !== 1) return res.status(404).json({ success: false, message: 'Property unavailable' });
      const total = Math.round(nights * Number(prop.price_per_night || 0) * 100) / 100;
      const clash = await dbAll('SELECT id FROM bookings WHERE property_id = ? AND payment_status IN (\'pending\',\'paid\') AND NOT (check_out <= ? OR check_in >= ?) LIMIT 1', [b.property_id, ci, co]);
      if (clash && clash.length) return res.status(409).json({ success: false, message: 'Dates already booked' });
      let ref = null;
      for (let i = 0; i < 8; i++) {
        const c = genReference();
        const ex = await dbGet('SELECT id FROM bookings WHERE booking_reference = ? LIMIT 1', [c]);
        if (!ex) { ref = c; break; }
      }
      if (!ref) return res.status(500).json({ success: false, message: 'Retry booking' });
      await dbRun('INSERT INTO bookings (property_id, user_id, guest_name, guest_email, guest_phone, check_in, check_out, total_price, booking_reference, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\')', [Number(b.property_id), null, String(b.guest_name).trim(), String(b.guest_email).trim().toLowerCase(), String(b.guest_phone).trim(), ci, co, total, ref]);
      res.json({ success: true, reference: ref, total_price: total });
    } catch (e) { res.status(500).json({ success: false, message: 'Booking failed' }); }
  });

  router.get('/admin/bookings', requireAdmin, async function (req, res) {
    try {
      const rows = await dbAll('SELECT b.*, p.title AS property_title, p.location AS property_location FROM bookings b LEFT JOIN properties p ON p.id = b.property_id ORDER BY b.created_at DESC, b.id DESC LIMIT 500');
      res.json({ success: true, bookings: rows || [] });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load bookings' }); }
  });

  router.post('/admin/properties', requireAdmin, async function (req, res) {
    try {
      const p = req.body || {};
      const price = Number(p.price_per_night);
      if (!p.title) return res.status(400).json({ success: false, message: 'Title required' });
      if (!p.location) return res.status(400).json({ success: false, message: 'Location required' });
      if (!price || price <= 0) return res.status(400).json({ success: false, message: 'Invalid price' });
      const na = function (v) { if (Array.isArray(v)) return v; if (typeof v === 'string' && v.trim()) { try { const q = JSON.parse(v); if (Array.isArray(q)) return q; } catch (x) {} return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean); } return []; };
      const r = await dbRun('INSERT INTO properties (title, description, location, price_per_night, max_guests, amenities, images, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [String(p.title).trim(), String(p.description || ''), String(p.location).trim(), price, Math.max(1, Number(p.max_guests) || 2), JSON.stringify(na(p.amenities)), JSON.stringify(na(p.images)), Number(p.is_active) === 0 ? 0 : 1]);
      res.json({ success: true, id: r && r.lastID != null ? Number(r.lastID) : undefined });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not create property' }); }
  });

  const updStatus = async function (req, res) {
    try {
      const st = String(((req.body || {}).payment_status) || '').toLowerCase();
      if (['pending', 'paid', 'cancelled'].indexOf(st) < 0) return res.status(400).json({ success: false, message: 'Bad status' });
      const ex = await dbGet('SELECT id FROM bookings WHERE id = ? LIMIT 1', [req.params.id]);
      if (!ex) return res.status(404).json({ success: false, message: 'Not found' });
      await dbRun('UPDATE bookings SET payment_status = ? WHERE id = ?', [st, req.params.id]);
      res.json({ success: true, id: Number(req.params.id), payment_status: st });
    } catch (e) { res.status(500).json({ success: false, message: 'Update failed' }); }
  };
  router.patch('/admin/bookings/:id', requireAdmin, updStatus);
  router.put('/admin/bookings/:id', requireAdmin, updStatus);

  return router;
}

module.exports.createStayApiRouter = createStayApiRouter;
