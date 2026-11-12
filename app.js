// App Express usado tanto localmente (server.js) quanto na Vercel (api/index.js)
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');

// ---------- armazenamento: Upstash Redis (Vercel) ou arquivo local (desenvolvimento) ----------
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const DATA = path.join(__dirname, 'data'), UP = path.join(DATA, 'uploads');
function localKV() {
  fs.mkdirSync(UP, { recursive: true });
  const F = path.join(DATA, 'kv.json'); let m = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F, 'utf8')) : { d: {}, x: {} }, t;
  const flush = () => { clearTimeout(t); t = setTimeout(() => fs.writeFileSync(F, JSON.stringify(m)), 300); };
  const alive = k => { if (m.x[k] && m.x[k] < Date.now()) { delete m.d[k]; delete m.x[k]; } return k in m.d; };
  return {
    async get(k) { return alive(k) ? JSON.parse(JSON.stringify(m.d[k])) : null; },
    async set(k, v, o = {}) { if (o.nx && alive(k)) return null; m.d[k] = JSON.parse(JSON.stringify(v)); if (o.ex) m.x[k] = Date.now() + o.ex * 1000; else delete m.x[k]; flush(); return 'OK'; },
    async del(k) { delete m.d[k]; delete m.x[k]; flush(); },
    async incr(k) { alive(k); m.d[k] = (m.d[k] || 0) + 1; flush(); return m.d[k]; },
    async expire(k, s) { m.x[k] = Date.now() + s * 1000; flush(); },
    async hincrby(k, f, n) { alive(k); const h = (m.d[k] ||= {}); h[f] = (h[f] || 0) + n; flush(); return h[f]; },
    async hset(k, o) { alive(k); Object.assign((m.d[k] ||= {}), o); flush(); },
    async hgetall(k) { return alive(k) ? { ...m.d[k] } : null; }
  };
}
const R = RURL ? new (require('@upstash/redis').Redis)({ url: RURL, token: RTOK }) : localKV();
const BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

const id = () => crypto.randomBytes(6).toString('hex');
const hash = (p, salt = crypto.randomBytes(8).toString('hex')) => salt + ':' + crypto.scryptSync(p, salt, 32).toString('hex');
const check = (p, h) => { const [s] = h.split(':'); return hash(p, s) === h; };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const ONLINE_MS = 12 * 60000; // tablet "online" = sinal nos últimos 12 min (ele reporta a cada 5)

// ---------- dados principais (1 documento; muda só quando o painel é usado) ----------
let cache = null, cacheT = 0;
async function getDb(fresh) {
  if (!fresh && cache && Date.now() - cacheT < 15000) return cache;
  let d = await R.get('db');
  if (!d) {
    const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(5).toString('hex'), user = process.env.ADMIN_USER || 'admin';
    await R.set('db', { admins: [{ id: id(), user, hash: hash(pw), role: 'owner' }], clients: [], ads: [], devices: [], settings: { price15: 0, price30: 0 }, log: [] }, { nx: true });
    if (!process.env.ADMIN_PASSWORD) console.log(`\n>>> Primeiro acesso: usuario "${user}"  senha "${pw}"\n`);
    d = await R.get('db');
  }
  cache = d; cacheT = Date.now(); return d;
}
const saveDb = async d => { await R.set('db', d); cache = d; cacheT = Date.now(); };
const commit = async (req, msg) => {
  if (msg) { req.db.log.unshift({ t: Date.now(), user: req.admin?.user || '—', msg }); req.db.log.length = Math.min(req.db.log.length, 300); }
  await saveDb(req.db);
};

function adStatus(a) {
  const t = today();
  if (!a.active) return 'pausado';
  if (t > a.end) return 'vencido';
  if (t < a.start) return 'agendado';
  return 'ativo';
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cookie = (req, n) => (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(k => k[0] === n)?.[1];

app.post('/api/login', h(async (req, res) => {
  const fk = 'fails:' + req.ip, n = +(await R.get(fk)) || 0;
  if (n >= 8) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 10 minutos.' });
  const db = await getDb(true), a = db.admins.find(x => x.user === req.body.user);
  if (!a || !check(req.body.pass || '', a.hash)) { await R.incr(fk); await R.expire(fk, 600); return res.status(401).json({ error: 'Usuário ou senha inválidos' }); }
  await R.del(fk);
  const sid = crypto.randomBytes(24).toString('hex'); await R.set('sess:' + sid, a.id, { ex: 2592000 });
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${process.env.VERCEL ? '; Secure' : ''}`);
  res.json({ ok: true });
}));
app.post('/api/logout', h(async (req, res) => { const s = cookie(req, 'sid'); if (s) await R.del('sess:' + s); res.json({ ok: true }); }));

// ---------- player (tablets) ----------
app.get('/api/playlist/:token', h(async (req, res) => {
  const db = await getDb(), d = db.devices.find(x => x.token === req.params.token);
  if (!d) return res.status(404).json({ error: 'tablet desconhecido' });
  await R.hset('dev:' + d.id, { lastSeen: Date.now() });
  const items = db.ads.filter(a => adStatus(a) === 'ativo' && (!a.devices?.length || a.devices.includes(d.id)))
    .map(a => ({ id: a.id, type: a.type, url: a.url, duration: a.duration }));
  res.json({ items, refresh: 300 });
}));
app.post('/api/log/:token', h(async (req, res) => {
  const db = await getDb(), d = db.devices.find(x => x.token === req.params.token); if (!d) return res.sendStatus(404);
  const day = today(), ok = new Set(db.ads.map(a => a.id)); let total = 0;
  for (const p of (req.body.plays || []).slice(0, 100)) if (ok.has(p.id) && +p.n > 0) { const n = Math.min(+p.n, 5000); total += n; await R.hincrby('stats:' + p.id, day, n); }
  if (total) await R.hincrby('dev:' + d.id, 'p' + day, total);
  await R.hset('dev:' + d.id, { lastSeen: Date.now() });
  res.json({ ok: true });
}));

// ---------- upload direto para o Vercel Blob (arquivos grandes não passam pela função) ----------
app.post('/api/blob', h(async (req, res) => {
  const { handleUpload } = require('@vercel/blob/client');
  try {
    res.json(await handleUpload({
      body: req.body, request: req,
      onBeforeGenerateToken: async () => {
        const s = await R.get('sess:' + cookie(req, 'sid')); if (!s) throw new Error('Não autorizado');
        return { allowedContentTypes: ['image/*', 'video/*'], maximumSizeInBytes: 300 * 1024 * 1024, addRandomSuffix: true };
      },
      onUploadCompleted: async () => { }
    }));
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

// ---------- admin ----------
const adm = express.Router(); app.use('/api/admin', adm);
adm.use(h(async (req, res, next) => {
  const aid = await R.get('sess:' + cookie(req, 'sid'));
  req.db = await getDb(true); req.admin = aid && req.db.admins.find(a => a.id === aid);
  if (!req.admin) return res.status(401).json({ error: 'login' });
  next();
}));
const owner = (req, res, next) => req.admin.role === 'owner' ? next() : res.status(403).json({ error: 'Apenas dono' });

adm.get('/state', h(async (req, res) => {
  const { db } = req, t = today(), from = addDays(t, -30);
  const [stats, devs] = await Promise.all([
    Promise.all(db.ads.map(a => R.hgetall('stats:' + a.id))),
    Promise.all(db.devices.map(d => R.hgetall('dev:' + d.id)))
  ]);
  const daily = Array.from({ length: 14 }, (_, i) => ({ d: addDays(t, i - 13), n: 0 }));
  const ads = db.ads.map((a, i) => {
    const s = stats[i] || {}; let p30 = 0;
    for (const [d, n] of Object.entries(s)) { if (d >= from) p30 += +n; const x = daily.find(q => q.d === d); if (x) x.n += +n; }
    return { ...a, status: adStatus(a), daysLeft: Math.round((new Date(a.end) - new Date(t)) / 864e5), plays30: p30, playsToday: +s[t] || 0 };
  });
  const price = a => +db.settings['price' + a.duration] || 0;
  res.json({
    me: { id: req.admin.id, user: req.admin.user, role: req.admin.role }, ads, clients: db.clients, settings: db.settings, daily, today: t,
    revenue: ads.filter(a => a.status === 'ativo').reduce((s, a) => s + price(a), 0), blob: BLOB ? 'vercel' : 'local',
    devices: db.devices.map((d, i) => ({ ...d, lastSeen: +devs[i]?.lastSeen || 0, online: Date.now() - (+devs[i]?.lastSeen || 0) < ONLINE_MS, playsToday: +devs[i]?.['p' + t] || 0 })),
    admins: db.admins.map(a => ({ id: a.id, user: a.user, role: a.role })), log: db.log.slice(0, 100)
  });
}));

adm.post('/clients', h(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Informe o nome' });
  req.db.clients.push({ id: id(), name: req.body.name, contact: req.body.contact || '', notes: req.body.notes || '' });
  await commit(req, 'Cliente criado: ' + req.body.name); res.json({ ok: true });
}));
adm.put('/clients/:id', h(async (req, res) => {
  const c = req.db.clients.find(x => x.id === req.params.id); if (!c) return res.sendStatus(404);
  for (const k of ['name', 'contact', 'notes']) if (k in req.body) c[k] = req.body[k];
  await commit(req, 'Cliente editado: ' + c.name); res.json({ ok: true });
}));
adm.delete('/clients/:id', h(async (req, res) => {
  if (req.db.ads.some(a => a.clientId === req.params.id)) return res.status(400).json({ error: 'Este cliente ainda tem anúncios. Exclua os anúncios primeiro.' });
  const c = req.db.clients.find(x => x.id === req.params.id);
  req.db.clients = req.db.clients.filter(x => x.id !== req.params.id); await commit(req, 'Cliente excluído: ' + c?.name); res.json({ ok: true });
}));

adm.post('/devices', h(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Informe o nome' });
  req.db.devices.push({ id: id(), name: req.body.name, token: crypto.randomBytes(8).toString('hex') });
  await commit(req, 'Tablet criado: ' + req.body.name); res.json({ ok: true });
}));
adm.put('/devices/:id', h(async (req, res) => {
  const d = req.db.devices.find(x => x.id === req.params.id); if (!d) return res.sendStatus(404);
  d.name = req.body.name || d.name; await commit(req, 'Tablet renomeado: ' + d.name); res.json({ ok: true });
}));
adm.post('/devices/:id/token', h(async (req, res) => {
  const d = req.db.devices.find(x => x.id === req.params.id); if (!d) return res.sendStatus(404);
  d.token = crypto.randomBytes(8).toString('hex'); await commit(req, 'Link do tablet renovado: ' + d.name); res.json({ ok: true });
}));
adm.delete('/devices/:id', h(async (req, res) => {
  const d = req.db.devices.find(x => x.id === req.params.id);
  req.db.devices = req.db.devices.filter(x => x.id !== req.params.id);
  req.db.ads.forEach(a => a.devices = (a.devices || []).filter(i => i !== req.params.id));
  await commit(req, 'Tablet excluído: ' + d?.name); res.json({ ok: true });
}));

adm.post('/admins', owner, h(async (req, res) => {
  const { user, pass, role } = req.body;
  if (!user || !pass || pass.length < 6 || req.db.admins.some(a => a.user === user)) return res.status(400).json({ error: 'Usuário inválido/já existe, ou senha com menos de 6 caracteres' });
  req.db.admins.push({ id: id(), user, hash: hash(pass), role: role === 'owner' ? 'owner' : 'admin' }); await commit(req, 'Admin criado: ' + user); res.json({ ok: true });
}));
adm.delete('/admins/:id', owner, h(async (req, res) => {
  if (req.params.id === req.admin.id) return res.status(400).json({ error: 'Você não pode excluir a si mesmo' });
  const a = req.db.admins.find(x => x.id === req.params.id);
  req.db.admins = req.db.admins.filter(x => x.id !== req.params.id); await commit(req, 'Admin excluído: ' + a?.user); res.json({ ok: true });
})); // (sessões do excluído deixam de valer: o login confere se o admin ainda existe)
adm.post('/admins/:id/password', owner, h(async (req, res) => {
  const a = req.db.admins.find(x => x.id === req.params.id);
  if (!a || (req.body.pass || '').length < 6) return res.status(400).json({ error: 'Senha com no mínimo 6 caracteres' });
  a.hash = hash(req.body.pass); await commit(req, 'Senha redefinida: ' + a.user); res.json({ ok: true });
}));
adm.post('/password', h(async (req, res) => {
  if (!check(req.body.old || '', req.admin.hash)) return res.status(400).json({ error: 'Senha atual incorreta' });
  if ((req.body.pass || '').length < 6) return res.status(400).json({ error: 'Nova senha com no mínimo 6 caracteres' });
  req.admin.hash = hash(req.body.pass); await commit(req, 'Alterou a própria senha'); res.json({ ok: true });
}));
adm.put('/settings', owner, h(async (req, res) => { req.db.settings = { price15: +req.body.price15 || 0, price30: +req.body.price30 || 0 }; await commit(req, 'Preços atualizados'); res.json({ ok: true }); }));
adm.get('/backup', owner, h(async (req, res) => {
  const stats = {}; await Promise.all(req.db.ads.map(async a => stats[a.id] = await R.hgetall('stats:' + a.id)));
  await commit(req, 'Backup baixado');
  res.setHeader('Content-Disposition', 'attachment; filename="backup-vallemidia-' + today() + '.json"'); res.json({ ...req.db, stats });
}));

// upload local (só desenvolvimento, sem Vercel Blob)
if (!BLOB) {
  const multer = require('multer');
  const up = multer({
    storage: multer.diskStorage({ destination: UP, filename: (r, f, cb) => cb(null, id() + path.extname(f.originalname).toLowerCase()) }),
    limits: { fileSize: 300 * 1024 * 1024 }, fileFilter: (r, f, cb) => cb(null, /^(image|video)\//.test(f.mimetype))
  });
  fs.mkdirSync(UP, { recursive: true });
  app.use('/media', express.static(UP, { maxAge: '365d', immutable: true }));
  adm.post('/upload', up.single('file'), (req, res) => req.file ? res.json({ url: '/media/' + req.file.filename, contentType: req.file.mimetype }) : res.status(400).json({ error: 'Arquivo inválido (imagem ou vídeo)' }));
}

adm.post('/ads', h(async (req, res) => {
  const b = req.body, t = today();
  const okUrl = typeof b.url === 'string' && (b.url.startsWith('/media/') || /^https:\/\/[\w-]+\.public\.blob\.vercel-storage\.com\//.test(b.url));
  if (!okUrl || !b.clientId || !b.title) return res.status(400).json({ error: 'Dados do anúncio inválidos' });
  req.db.ads.push({
    id: id(), clientId: b.clientId, title: b.title, url: b.url, type: String(b.contentType).startsWith('video') ? 'video' : 'image',
    duration: +b.duration === 30 ? 30 : 15, start: b.start || t, end: b.end || addDays(t, 30), active: true,
    devices: [].concat(b.devices || []).filter(Boolean)
  });
  await commit(req, 'Anúncio criado: ' + b.title); res.json({ ok: true });
}));
adm.put('/ads/:id', h(async (req, res) => {
  const a = req.db.ads.find(x => x.id === req.params.id); if (!a) return res.sendStatus(404);
  for (const k of ['title', 'clientId', 'start', 'end', 'active', 'devices']) if (k in req.body) a[k] = req.body[k];
  if ('duration' in req.body) a.duration = +req.body.duration === 30 ? 30 : 15;
  await commit(req, 'Anúncio editado: ' + a.title); res.json({ ok: true });
}));
adm.post('/ads/:id/renew', h(async (req, res) => {
  const a = req.db.ads.find(x => x.id === req.params.id); if (!a) return res.sendStatus(404);
  const base = a.end > today() ? a.end : today(), days = Math.min(Math.max(+req.body.days || 30, 1), 3650);
  a.end = addDays(base, days); a.active = true; await commit(req, `Anúncio renovado (+${days}d): ${a.title}`); res.json({ ok: true, end: a.end });
}));
adm.delete('/ads/:id', h(async (req, res) => {
  const a = req.db.ads.find(x => x.id === req.params.id);
  if (a) {
    if (a.url.startsWith('/media/')) fs.unlink(path.join(UP, path.basename(a.url)), () => { });
    else try { await require('@vercel/blob').del(a.url); } catch { }
    req.db.ads = req.db.ads.filter(x => x !== a); await R.del('stats:' + a.id); await commit(req, 'Anúncio excluído: ' + a.title);
  }
  res.json({ ok: true });
}));

app.use((e, req, res, next) => { console.error(e); res.status(500).json({ error: 'Erro interno: ' + e.message }); });
module.exports = app;
