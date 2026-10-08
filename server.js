const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const path = require('path');

const {
  DATABASE_URL, JWT_SECRET, APP_URL = 'http://localhost:3000',
  ADMIN_USER = 'JalilAlegre', ADMIN_EMAIL, ADMIN_PASSWORD,
  SMTP_HOST, SMTP_PORT = 587, SMTP_USER, SMTP_PASS, MAIL_FROM, PORT = 3000,
} = process.env;
if (!JWT_SECRET) throw new Error('Falta la variable JWT_SECRET');
const prod = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const q = (t, p) => pool.query(t, p);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer',
  verified BOOLEAN NOT NULL DEFAULT false, vtoken TEXT, created TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS catalog(
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, descr TEXT DEFAULT '',
  cost INT NOT NULL CHECK (cost > 0), active BOOLEAN DEFAULT true);
CREATE TABLE IF NOT EXISTS ledger(
  id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
  pts INT NOT NULL, amount NUMERIC, created TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS redemptions(
  id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
  item_id INT, name TEXT, cost INT NOT NULL, code TEXT NOT NULL,
  used BOOLEAN DEFAULT false, created TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`;

// ---------- utilidades ----------
const BAL = '(SELECT COALESCE(SUM(pts),0) FROM ledger WHERE user_id=$1)-(SELECT COALESCE(SUM(cost),0) FROM redemptions WHERE user_id=$1)';
const balance = async (id, c = pool) => +(await c.query('SELECT ' + BAL + ' AS b', [id])).rows[0].b;
const getRate = async () => +((await q("SELECT value FROM settings WHERE key='rate'")).rows[0]?.value) || 100;
const bad = (res, error, code = 400) => res.status(code).json({ error });
const h = (f) => (req, res) => f(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Error del servidor' }); });

const mailer = SMTP_HOST
  ? nodemailer.createTransport({ host: SMTP_HOST, port: +SMTP_PORT, secure: +SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;
async function sendVerify(to, token) {
  const link = `${APP_URL}/api/verify?token=${token}`;
  if (!mailer) return console.log('[SIN SMTP] Enlace de verificación:', link);
  await mailer.sendMail({
    from: MAIL_FROM || SMTP_USER, to, subject: 'Confirma tu cuenta de VamosRapido',
    html: `<p>¡Hola! Confirma tu cuenta para empezar a sumar puntos:</p><p><a href="${link}">Confirmar mi cuenta</a></p><p>Si no fuiste tú, ignora este mensaje.</p>`,
  });
}

const auth = (role) => async (req, res, next) => {
  try {
    const t = jwt.verify(req.cookies.vr, JWT_SECRET);
    const u = (await q('SELECT id,username,display,role FROM users WHERE id=$1 AND verified', [t.id])).rows[0];
    if (!u) throw new Error('x');
    if (role && u.role !== role) return bad(res, 'Sin permiso', 403);
    req.u = u; next();
  } catch (e) { bad(res, 'No autenticado', 401); }
};

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

app.post('/api/register', limiter, h(async (req, res) => {
  const display = String(req.body.username || '').trim(), username = display.toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return bad(res, 'Usuario: 3 a 20 letras, números o _');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return bad(res, 'Escribe un email válido');
  if (pw.length < 8) return bad(res, 'La contraseña debe tener al menos 8 caracteres');
  if (username === ADMIN_USER.toLowerCase()) return bad(res, 'Ese usuario está reservado');
  const token = crypto.randomBytes(24).toString('hex');
  try {
    await q('INSERT INTO users(username,display,email,hash,vtoken) VALUES($1,$2,$3,$4,$5)',
      [username, display, email, await bcrypt.hash(pw, 10), token]);
  } catch (e) { if (e.code === '23505') return bad(res, 'Ese usuario o email ya está registrado'); throw e; }
  await sendVerify(email, token);
  res.json({ ok: true });
}));

app.post('/api/resend', limiter, h(async (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  const r = await q('UPDATE users SET vtoken=$1 WHERE email=$2 AND NOT verified RETURNING email', [token, String(req.body.email || '').trim().toLowerCase()]);
  if (r.rowCount) await sendVerify(r.rows[0].email, token);
  res.json({ ok: true });
}));

app.get('/api/verify', h(async (req, res) => {
  const r = await q('UPDATE users SET verified=true, vtoken=NULL WHERE vtoken=$1 RETURNING id', [String(req.query.token || '')]);
  res.redirect(r.rowCount ? '/?verified=1' : '/?verified=0');
}));

app.post('/api/login', limiter, h(async (req, res) => {
  const u = (await q('SELECT * FROM users WHERE username=$1', [String(req.body.username || '').trim().toLowerCase()])).rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.hash))) return bad(res, 'Usuario o contraseña incorrectos', 401);
  if (!u.verified) return bad(res, 'Confirma tu email antes de ingresar. Revisa tu correo.', 403);
  res.cookie('vr', jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' }),
    { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 30 * 864e5 });
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { res.clearCookie('vr'); res.json({ ok: true }); });

app.get('/api/me', auth(), h(async (req, res) =>
  res.json({ user: req.u, balance: req.u.role === 'admin' ? 0 : await balance(req.u.id), rate: await getRate() })));

app.get('/api/history', auth(), h(async (req, res) => {
  const a = await q('SELECT pts, created FROM ledger WHERE user_id=$1', [req.u.id]);
  const b = await q('SELECT name, cost, created FROM redemptions WHERE user_id=$1', [req.u.id]);
  const rows = [...a.rows.map((x) => ({ t: 'Compra', v: '+' + x.pts, ts: x.created })),
    ...b.rows.map((x) => ({ t: 'Canje: ' + x.name, v: '−' + x.cost, ts: x.created }))]
    .sort((x, y) => new Date(y.ts) - new Date(x.ts));
  res.json({ rows });
}));

app.get('/api/catalog', auth(), h(async (req, res) => {
  const w = req.u.role === 'admin' ? '' : 'WHERE active';
  res.json({ items: (await q(`SELECT id,name,descr,cost,active FROM catalog ${w} ORDER BY cost, id`)).rows });
}));

app.post('/api/redeem', auth(), h(async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.u.id]); // evita canjes simultáneos
    const it = (await c.query('SELECT * FROM catalog WHERE id=$1 AND active', [+req.body.itemId])).rows[0];
    if (!it) { await c.query('ROLLBACK'); return bad(res, 'Ese premio ya no está disponible'); }
    if ((await balance(req.u.id, c)) < it.cost) { await c.query('ROLLBACK'); return bad(res, 'No te alcanzan los puntos'); }
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    await c.query('INSERT INTO redemptions(user_id,item_id,name,cost,code) VALUES($1,$2,$3,$4,$5)', [req.u.id, it.id, it.name, it.cost, code]);
    await c.query('COMMIT');
    res.json({ ok: true, code });
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));

app.get('/api/coupons', auth(), h(async (req, res) =>
  res.json({ rows: (await q('SELECT id,name,code,used,created FROM redemptions WHERE user_id=$1 ORDER BY created DESC', [req.u.id])).rows })));

// ---------- administrador ----------
const admin = auth('admin');

app.get('/api/users', admin, h(async (req, res) => {
  const s = '%' + String(req.query.q || '').trim().toLowerCase() + '%';
  res.json({ users: (await q("SELECT username,display FROM users WHERE role='customer' AND verified AND (username LIKE $1 OR LOWER(display) LIKE $1) ORDER BY display LIMIT 50", [s])).rows });
}));

app.get('/api/users/:u', admin, h(async (req, res) => {
  const u = (await q("SELECT id,username,display,email FROM users WHERE username=$1 AND role='customer' AND verified", [req.params.u.toLowerCase()])).rows[0];
  if (!u) return bad(res, 'Cliente no encontrado', 404);
  const coupons = (await q('SELECT id,name,code FROM redemptions WHERE user_id=$1 AND NOT used ORDER BY created', [u.id])).rows;
  res.json({ username: u.username, display: u.display, email: u.email, balance: await balance(u.id), coupons });
}));

app.post('/api/points', admin, h(async (req, res) => {
  const amount = +req.body.amount, pts = Math.floor(amount / (await getRate()));
  if (!(pts > 0)) return bad(res, 'El monto no alcanza para sumar puntos');
  const u = (await q("SELECT id FROM users WHERE username=$1 AND role='customer'", [String(req.body.username || '').toLowerCase()])).rows[0];
  if (!u) return bad(res, 'Cliente no encontrado', 404);
  await q('INSERT INTO ledger(user_id,pts,amount) VALUES($1,$2,$3)', [u.id, pts, amount]);
  res.json({ pts, balance: await balance(u.id) });
}));

app.post('/api/coupons/:id/use', admin, h(async (req, res) => {
  await q('UPDATE redemptions SET used=true WHERE id=$1', [+req.params.id]); res.json({ ok: true });
}));

app.put('/api/rate', admin, h(async (req, res) => {
  const r = Math.floor(+req.body.rate);
  if (!(r > 0)) return bad(res, 'Valor inválido');
  await q("INSERT INTO settings(key,value) VALUES('rate',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [String(r)]);
  res.json({ ok: true });
}));

app.post('/api/catalog', admin, h(async (req, res) => {
  const name = String(req.body.name || '').trim(), cost = Math.floor(+req.body.cost);
  if (!name || !(cost > 0)) return bad(res, 'Completa nombre y costo');
  await q('INSERT INTO catalog(name,descr,cost) VALUES($1,$2,$3)', [name, String(req.body.descr || '').trim(), cost]);
  res.json({ ok: true });
}));
app.patch('/api/catalog/:id', admin, h(async (req, res) => {
  await q('UPDATE catalog SET active=$1 WHERE id=$2', [!!req.body.active, +req.params.id]); res.json({ ok: true });
}));
app.delete('/api/catalog/:id', admin, h(async (req, res) => {
  await q('DELETE FROM catalog WHERE id=$1', [+req.params.id]); res.json({ ok: true });
}));

// ---------- web ----------
app.use(express.static(path.join(__dirname, 'public')));
// Enlace del llavero NFC / QR: /c/<usuario>
app.get('/c/:u', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

(async () => {
  await q(SCHEMA);
  if (ADMIN_PASSWORD && ADMIN_EMAIL) {
    await q("INSERT INTO users(username,display,email,hash,role,verified) VALUES($1,$2,$3,$4,'admin',true) ON CONFLICT(username) DO NOTHING",
      [ADMIN_USER.toLowerCase(), ADMIN_USER, ADMIN_EMAIL.toLowerCase(), await bcrypt.hash(ADMIN_PASSWORD, 10)]);
  }
  app.listen(PORT, () => console.log('VamosRapido escuchando en el puerto ' + PORT));
})().catch((e) => { console.error(e); process.exit(1); });
