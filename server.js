const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, 'data', 'db.json');
const sessions = new Map();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readDB() { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
function writeDB(db) { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); }
function id(prefix) { return `${prefix}-${crypto.randomBytes(5).toString('hex')}`; }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}
function safeUser(u) {
  return u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null;
}
function getUser(req) {
  const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('parksense_session='))?.split('=')[1];
  const userId = token && sessions.get(token);
  if (!userId) return null;
  const db = readDB();
  return db.users.find(u => u.id === userId) || null;
}
function requireAuth(req, res) {
  const user = getUser(req);
  if (!user) { res.status(401).json({ error: 'Please sign in to continue.' }); return null; }
  return user;
}
function ownerVisibleParking(user, db) {
  if (user.role === 'operator') return db.parking.filter(p => p.ownerId === user.id);
  return db.parking;
}
function flattenSpaces(p) {
  return (p.floors || []).flatMap(f => (f.areas || []).flatMap(a => (a.spaces || []).map(s => ({ ...s, floorId: f.id, floorName: f.name, areaId: a.id, areaName: a.name }))));
}
function stats(p) {
  const spaces = flattenSpaces(p);
  const total = spaces.length;
  const free = spaces.filter(s => s.status === 'free').length;
  const occupied = spaces.filter(s => s.status === 'occupied').length;
  const reserved = spaces.filter(s => s.status === 'reserved').length;
  return { total, free, occupied, reserved, occupancy: total ? Math.round(occupied / total * 100) : 0, availability: total ? Math.round(free / total * 100) : 0 };
}
function publicParking(p) { return { ...p, stats: stats(p) }; }
function seedPasswords(db) {
  let changed = false;
  const defaults = { 'driver-1': 'driver123', 'operator-1': 'operator123' };
  for (const u of db.users) {
    if (!u.passwordHash && defaults[u.id]) { u.passwordHash = hashPassword(defaults[u.id]); changed = true; }
  }
  if (changed) writeDB(db);
}
function ownerCheck(user, p) { return user.role === 'operator' && p && p.ownerId === user.id; }
function ensureOperator(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'operator') { res.status(403).json({ error: 'Operator access is required.' }); return null; }
  return user;
}

app.get('/api/me', (req, res) => res.json({ user: safeUser(getUser(req)) }));

app.post('/api/auth/signup', (req, res) => {
  const db = readDB();
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'operator' ? 'operator' : 'driver';
  if (!name || !email || password.length < 6) return res.status(400).json({ error: 'Enter your name, a valid email and a password of at least 6 characters.' });
  if (db.users.some(u => u.email === email)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const user = { id: id('usr'), name, email, passwordHash: hashPassword(password), role, createdAt: new Date().toISOString() };
  db.users.push(user);
  writeDB(db);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, user.id);
  res.setHeader('Set-Cookie', `parksense_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  res.status(201).json({ user: safeUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const db = readDB(); seedPasswords(db);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.users.find(u => u.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ error: 'Invalid email or password.' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, user.id);
  res.setHeader('Set-Cookie', `parksense_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  res.json({ user: safeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('parksense_session='))?.split('=')[1];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'parksense_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  const user = requireAuth(req, res); if (!user) return;
  const db = readDB(); seedPasswords(db);
  const parking = ownerVisibleParking(user, db).map(publicParking);
  const reservations = db.reservations.filter(r => r.userId === user.id || user.role === 'operator');
  const settings = db.settings?.[user.id] || { darkMode: false, notifications: true, units: 'metric' };
  res.json({ currentUser: safeUser(user), parking, reservations, settings });
});

app.get('/api/parking/:id', (req, res) => {
  const user = requireAuth(req, res); if (!user) return;
  const db = readDB();
  const p = ownerVisibleParking(user, db).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Parking not found.' });
  res.json({ ...publicParking(p), spaces: flattenSpaces(p) });
});

app.post('/api/parking', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB();
  const b = req.body;
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Parking name is required.' });
  const p = {
    id: id('parking'), ownerId: user.id, name, address: String(b.address || 'Address not set').trim(),
    lat: Number(b.lat) || 28.5439, lng: Number(b.lng) || 77.1553, rate: Number(b.rate) || 30, status: 'open',
    floors: [{ id: id('floor'), name: 'Ground Floor', areas: [{ id: 'A', name: 'Area A', spaces: [] }] }],
    createdAt: new Date().toISOString()
  };
  db.parking.push(p); writeDB(db); res.status(201).json(publicParking(p));
});

app.put('/api/parking/:id', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id);
  if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  Object.assign(p, {
    name: req.body.name ?? p.name, address: req.body.address ?? p.address,
    lat: Number(req.body.lat ?? p.lat), lng: Number(req.body.lng ?? p.lng),
    rate: Number(req.body.rate ?? p.rate), status: req.body.status ?? p.status
  });
  writeDB(db); res.json(publicParking(p));
});

app.delete('/api/parking/:id', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id);
  if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  db.parking = db.parking.filter(x => x.id !== p.id);
  db.reservations = db.reservations.filter(r => r.parkingId !== p.id);
  writeDB(db); res.json({ ok: true });
});

app.post('/api/parking/:id/floors', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id);
  if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  p.floors.push({ id: id('floor'), name: String(req.body.name || `Level ${p.floors.length}`), areas: [] });
  writeDB(db); res.json(publicParking(p));
});

app.put('/api/parking/:id/floor/:floorId', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id);
  if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  const f = p.floors.find(x => x.id === req.params.floorId); if (!f) return res.status(404).json({ error: 'Floor not found.' });
  if (req.body.name) f.name = String(req.body.name).trim();
  writeDB(db); res.json(publicParking(p));
});

app.delete('/api/parking/:id/floor/:floorId', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id);
  if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  if (p.floors.length <= 1) return res.status(400).json({ error: 'A parking facility must keep at least one floor.' });
  p.floors = p.floors.filter(f => f.id !== req.params.floorId); writeDB(db); res.json(publicParking(p));
});

app.post('/api/parking/:id/areas', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id); if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  const f = p.floors.find(x => x.id === req.body.floorId); if (!f) return res.status(404).json({ error: 'Floor not found.' });
  const areaId = String(req.body.id || String.fromCharCode(65 + f.areas.length)).trim().toUpperCase();
  if (f.areas.some(a => a.id === areaId)) return res.status(409).json({ error: 'That area code already exists on this floor.' });
  f.areas.push({ id: areaId, name: String(req.body.name || `Area ${areaId}`).trim(), spaces: [] });
  writeDB(db); res.json(publicParking(p));
});

app.put('/api/parking/:id/area/:areaId', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id); if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  for (const f of p.floors) { const a = f.areas.find(x => x.id === req.params.areaId); if (a) { if (req.body.name) a.name = String(req.body.name).trim(); writeDB(db); return res.json(publicParking(p)); } }
  res.status(404).json({ error: 'Area not found.' });
});

app.delete('/api/parking/:id/area/:areaId', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id); if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  for (const f of p.floors) { const n=f.areas.length; f.areas=f.areas.filter(a=>a.id!==req.params.areaId); if(f.areas.length!==n){writeDB(db);return res.json({ok:true});} }
  res.status(404).json({ error: 'Area not found.' });
});

app.post('/api/parking/:id/spaces', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id); if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  const f = p.floors.find(x => x.id === req.body.floorId); const a = f?.areas.find(x => x.id === req.body.areaId); if (!a) return res.status(404).json({ error: 'Area not found.' });
  const spaceId = String(req.body.id || `${a.id}-${String(a.spaces.length + 1).padStart(2, '0')}`).trim();
  if (flattenSpaces(p).some(s => s.id === spaceId)) return res.status(409).json({ error: 'That bay label already exists.' });
  a.spaces.push({ id: spaceId, status: ['free','occupied','reserved'].includes(req.body.status) ? req.body.status : 'free', type: req.body.type || 'standard' });
  writeDB(db); res.json(publicParking(p));
});

app.put('/api/parking/:id/space/:spaceId', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id); if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  for (const f of p.floors) for (const a of f.areas) { const s=a.spaces.find(x=>x.id===req.params.spaceId); if(s){
    const newId = req.body.newId ? String(req.body.newId).trim() : s.id;
    if (newId !== s.id && flattenSpaces(p).some(x=>x.id===newId)) return res.status(409).json({error:'That bay label already exists.'});
    Object.assign(s,{status:req.body.status??s.status,type:req.body.type??s.type,id:newId}); writeDB(db); return res.json(s);
  }}
  res.status(404).json({ error: 'Space not found.' });
});

app.delete('/api/parking/:id/space/:spaceId', (req, res) => {
  const user = ensureOperator(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x => x.id === req.params.id); if (!ownerCheck(user, p)) return res.status(404).json({ error: 'Parking not found.' });
  for (const f of p.floors) for (const a of f.areas) { const n=a.spaces.length; a.spaces=a.spaces.filter(s=>s.id!==req.params.spaceId); if(a.spaces.length!==n){writeDB(db);return res.json({ok:true});} }
  res.status(404).json({error:'Space not found.'});
});

app.post('/api/reservations', (req, res) => {
  const user = requireAuth(req, res); if (!user) return;
  const db = readDB(); const p = db.parking.find(x=>x.id===req.body.parkingId); if(!p) return res.status(404).json({error:'Parking not found.'});
  const s = flattenSpaces(p).find(x=>x.id===req.body.spaceId); if(!s || s.status!=='free') return res.status(409).json({error:'That space is no longer available.'});
  for(const f of p.floors) for(const a of f.areas) for(const x of a.spaces) if(x.id===s.id) x.status='reserved';
  const r={id:id('reservation'),userId:user.id,parkingId:p.id,parkingName:p.name,spaceId:s.id,floorName:s.floorName,areaName:s.areaName,createdAt:new Date().toISOString(),status:'active'};
  db.reservations.unshift(r); writeDB(db); res.status(201).json(r);
});

app.delete('/api/reservations/:id', (req, res) => {
  const user = requireAuth(req, res); if (!user) return;
  const db=readDB(); const r=db.reservations.find(x=>x.id===req.params.id && (x.userId===user.id || user.role==='operator')); if(!r)return res.status(404).json({error:'Reservation not found.'});
  const p=db.parking.find(x=>x.id===r.parkingId); if(p) for(const f of p.floors) for(const a of f.areas) for(const s of a.spaces) if(s.id===r.spaceId && s.status==='reserved')s.status='free';
  db.reservations=db.reservations.filter(x=>x.id!==r.id); writeDB(db); res.json({ok:true});
});

app.put('/api/settings', (req,res)=>{ const user=requireAuth(req,res); if(!user)return; const db=readDB(); db.settings=db.settings||{}; db.settings[user.id]={...(db.settings[user.id]||{}),...req.body}; writeDB(db); res.json(db.settings[user.id]); });

app.get('/api/notifications', (req,res)=>{ const user=requireAuth(req,res); if(!user)return; const db=readDB(); const items=[]; const mine=db.reservations.filter(r=>r.userId===user.id && r.status==='active'); if(mine.length) items.push({title:'Reservation active',body:`${mine[0].parkingName} · ${mine[0].spaceId}`,time:'Now'}); if(user.role==='operator'){const own=db.parking.filter(p=>p.ownerId===user.id); const low=own.find(p=>p.stats?.free===0 || stats(p).free===0); if(low)items.push({title:'No spaces available',body:`${low.name} is currently full.`,time:'Now'});} if(!items.length)items.push({title:'Park Sense is ready',body:'Parking information is up to date.',time:'Now'}); res.json({items}); });

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT,()=>console.log(`ParkSense running on http://localhost:${PORT}`));
