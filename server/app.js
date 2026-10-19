'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { openDb, tx } = require('./db');
const A = require('./auth');
const { sendMail } = require('./mailer');
const { GROUPS, TAGS, FAV_CATEGORIES } = require('./data/taxonomy');
const { QUESTIONS, ANSWER_VALUES } = require('./data/questions');
const { VENUES } = require('./data/venues');
const { normalizeText } = require('./matching/engine');
const { scanProfileText } = require('./safety');
const { loadProfiles } = require('./profiles');
const social = require('./routes/social');

const PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 14;
const COOKIE = PROD ? '__Host-plm_sid' : 'plm_sid';
const RADII = [5, 10, 25, 50, 100];

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cleanStr = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

function createApp({ db = openDb(), mail = sendMail, fetchImpl = fetch } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.PLM_TRUST_PROXY) app.set('trust proxy', Number(process.env.PLM_TRUST_PROXY) || process.env.PLM_TRUST_PROXY);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"], 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"], 'font-src': ["'self'"], 'manifest-src': ["'self'"], 'base-uri': ["'none'"],
        'form-action': ["'self'"], 'frame-ancestors': ["'none'"], 'object-src': ["'none'"],
        ...(PROD ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: PROD ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
  }));
  app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=(), geolocation=(self)'); next(); });
  app.use(express.json({ limit: '16kb', strict: true }));

  // ---- CSRF: SameSite=Strict cookie + required custom header + same-origin check ----
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-plm-csrf') !== '1') return next(new HttpError(403, 'Bad request origin.'));
    const origin = req.get('origin');
    if (origin) { try { if (new URL(origin).host !== req.get('host')) return next(new HttpError(403, 'Bad request origin.')); } catch { return next(new HttpError(403, 'Bad request origin.')); } }
    if (Number(req.get('content-length') || 0) > 0 && !req.is('json')) return next(new HttpError(415, 'JSON required.'));
    next();
  });

  const limiter = (windowMs, limit, message, keyBy) => rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    ...(keyBy ? { keyGenerator: keyBy } : {}),
    validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
    handler: (req, res) => res.status(429).json({ error: message }),
  });
  const TEST = process.env.PLM_TEST === '1';
  const lim = (w, n, m, k) => (TEST ? (req, res, next) => next() : limiter(w, n, m, k));
  app.use('/api', lim(60_000, 240, 'Slow down a little — too many requests.'));
  const authLimiter = lim(15 * 60_000, 20, 'Too many attempts. Please wait a few minutes.');
  const byUser = (req) => `u${req.user?.id ?? req.ip}`;

  // ---- sessions ----
  const setSession = (res, userId) => {
    const token = A.newToken(); const now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(A.sha256(token), userId, now, now + SESSION_DAYS * 86_400_000);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: PROD, path: '/', maxAge: SESSION_DAYS * 86_400_000 });
  };
  const readCookie = (req, name) => (req.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
  app.use((req, res, next) => {
    const token = readCookie(req, COOKIE);
    if (!token || token.length > 80) return next();
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(A.sha256(token), Date.now());
    if (row) { req.user = row; req.sessionHash = A.sha256(token); }
    next();
  });
  const requireUser = (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in.'));
    if (req.user.status !== 'active') return next(new HttpError(403, 'Your account is under review by our safety team.', 'suspended'));
    next();
  };
  const requireReady = (req, res, next) => requireUser(req, res, (err) => {
    if (err) return next(err);
    if (!req.user.email_verified) return next(new HttpError(403, 'Please verify your email first — it keeps the community real.', 'verify_email'));
    if (!req.user.onboarded) return next(new HttpError(403, 'Finish your profile first.', 'onboarding'));
    next();
  });

  // ---- auth ----
  const failures = new Map(); // email -> {n, until}
  const issueCode = async (user) => {
    const code = A.newCode();
    db.prepare('INSERT INTO email_codes (user_id, code_hash, expires_at, attempts) VALUES (?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0')
      .run(user.id, A.sha256(`${user.id}:${code}`), Date.now() + 15 * 60_000);
    await mail({ to: user.email, subject: 'Your PeopleLikeMe code', text: `Your verification code is ${code}. It expires in 15 minutes. If you didn’t sign up, ignore this email.` });
    return !PROD ? code : undefined;
  };

  app.post('/api/signup', authLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const emailHash = A.sha256(email);
    if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
    // 18+ gate comes FIRST, before any account data is stored.
    const age = A.ageFromDob(String(b.dob || ''));
    if (age == null || age > 110) throw new HttpError(400, 'Enter your real date of birth.');
    const nope = 'You must be 18 or older to use PeopleLikeMe.';
    if (readCookie(req, 'plm_u18') === '1') throw new HttpError(403, nope, 'underage');
    if (age < 18) {
      db.prepare('INSERT OR IGNORE INTO email_blocklist (email_hash, reason, created_at) VALUES (?,?,?)').run(emailHash, 'underage', Date.now());
      res.cookie('plm_u18', '1', { httpOnly: true, sameSite: 'strict', secure: PROD, path: '/', maxAge: 365 * 86_400_000 });
      throw new HttpError(403, nope, 'underage');
    }
    if (b.agree !== true) throw new HttpError(400, 'Please confirm you are 18+ and accept the Terms and Privacy Policy.');
    const pwProblem = A.passwordProblem(b.password, email);
    if (pwProblem) throw new HttpError(400, pwProblem);
    const name = cleanStr(b.displayName, 24);
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,23}$/u.test(name)) throw new HttpError(400, 'Pick a display name (2–24 letters/numbers). You don’t need your real name.');
    if (scanProfileText(name)) throw new HttpError(400, 'Display names can’t contain links or contact details.');
    if (db.prepare('SELECT 1 FROM email_blocklist WHERE email_hash = ?').get(emailHash)) throw new HttpError(403, 'This email can’t be used on PeopleLikeMe.', 'blocked');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email is already registered — try signing in.');

    const pw = await A.hashPassword(b.password);
    const info = db.prepare('INSERT INTO users (pid, email, email_hash, pw_hash, display_name, dob, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(A.newPid(), email, emailHash, pw, name, b.dob, Date.now());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    setSession(res, user.id);
    let devCode; try { devCode = await issueCode(user); } catch (e) { console.error('mail failed:', e.message); }
    res.status(201).json({ ok: true, devCode });
  }));

  app.post('/api/login', authLimiter, wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(req.body?.password || '').slice(0, 128);
    const f = failures.get(email);
    if (f && f.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = await A.verifyPassword(password, user ? user.pw_hash : A.DUMMY_HASH);
    if (!user || !ok) {
      const stale = !f || Date.now() - f.last > 15 * 60_000;
      const n = (stale ? 0 : f.n) + 1;
      failures.set(email, { n, last: Date.now(), until: n >= 5 ? Date.now() + 15 * 60_000 : 0 });
      if (failures.size > 5000) failures.clear();
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    failures.delete(email);
    setSession(res, user.id);
    res.json({ ok: true });
  }));

  app.post('/api/logout', wrap(async (req, res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
    res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true });
  }));

  app.post('/api/verify', authLimiter, requireUser, wrap(async (req, res) => {
    const code = String(req.body?.code || '').trim();
    const row = db.prepare('SELECT * FROM email_codes WHERE user_id = ?').get(req.user.id);
    if (!row || row.expires_at < Date.now()) throw new HttpError(400, 'That code expired — request a new one.');
    if (row.attempts >= 5) throw new HttpError(429, 'Too many wrong codes. Request a new one.');
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ?').run(req.user.id);
    if (!/^\d{6}$/.test(code) || !A.safeEqual(A.sha256(`${req.user.id}:${code}`), row.code_hash)) throw new HttpError(400, 'That code isn’t right.');
    tx(db, () => { db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(req.user.id); db.prepare('DELETE FROM email_codes WHERE user_id = ?').run(req.user.id); });
    res.json({ ok: true });
  }));

  app.post('/api/verify/resend', lim(60 * 60_000, 5, 'Too many codes requested. Try again later.', byUser), requireUser, wrap(async (req, res) => {
    if (req.user.email_verified) return res.json({ ok: true });
    let devCode; try { devCode = await issueCode(req.user); } catch (e) { throw new HttpError(502, 'We couldn’t send the email right now.'); }
    res.json({ ok: true, devCode });
  }));

  // ---- me / meta ----
  const myProfile = (u) => {
    const p = loadProfiles(db, [u.id]).get(u.id);
    return {
      pid: u.pid, email: u.email, name: u.display_name, ageBand: A.ageBand(A.ageFromDob(u.dob)), emailVerified: !!u.email_verified, onboarded: !!u.onboarded,
      status: u.status, bio: u.bio, city: u.city, hasLocation: u.lat != null, radiusKm: u.radius_km,
      tags: p.tags, answers: p.answers, favs: p.favs.map((f) => ({ cat: f.cat, text: f.text })),
    };
  };
  app.get('/api/me', (req, res) => res.json({ user: req.user ? myProfile(req.user) : null }));
  app.get('/api/meta', (req, res) => res.json({
    groups: GROUPS.map((g) => ({ id: g.id, label: g.label, emoji: g.emoji, tags: g.tags.map((t) => ({ id: t.id, label: t.label, emoji: t.emoji })) })),
    questions: QUESTIONS.map((q) => ({ id: q.id, text: q.text, dim: q.dim })),
    favCategories: FAV_CATEGORIES, radii: RADII,
    venues: Object.fromEntries(Object.entries(VENUES).map(([k, v]) => [k, { label: v.label, emoji: v.emoji }])),
    minTags: 5, maxTags: 30,
  }));

  app.put('/api/profile', requireUser, wrap(async (req, res) => {
    const b = req.body || {};
    const name = cleanStr(b.displayName ?? req.user.display_name, 24);
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,23}$/u.test(name) || scanProfileText(name)) throw new HttpError(400, 'Display name: 2–24 letters/numbers, no links or contact details.');
    const bio = cleanStr(b.bio, 280);
    if (scanProfileText(bio)) throw new HttpError(400, 'Bios can’t contain links or contact details — share those only once you trust someone, in chat.');
    const city = cleanStr(b.city, 60);
    if (!city) throw new HttpError(400, 'Tell us your city or area so we can find people near you.');
    const keep = b.keepLocation === true && req.user.lat != null;
    const lat = keep ? req.user.lat : Number(b.lat), lng = keep ? req.user.lng : Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) throw new HttpError(400, 'Choose a location so we can find people near you.');
    const radius = Number(b.radiusKm);
    if (!RADII.includes(radius)) throw new HttpError(400, 'Choose a valid distance.');
    const tags = [...new Set(Array.isArray(b.tags) ? b.tags : [])];
    if (tags.some((t) => typeof t !== 'string' || !TAGS[t])) throw new HttpError(400, 'Unknown interest selected.');
    if (tags.length < 5 || tags.length > 30) throw new HttpError(400, 'Pick between 5 and 30 interests.');
    const answers = b.answers && typeof b.answers === 'object' ? b.answers : {};
    for (const q of QUESTIONS) if (!(answers[q.id] in ANSWER_VALUES)) throw new HttpError(400, 'Please answer every Yes / Maybe / No question.');
    const favs = [];
    for (const c of FAV_CATEGORIES) {
      const list = Array.isArray(b.favs?.[c.id]) ? b.favs[c.id].slice(0, 3) : [];
      for (const raw of list) {
        const text = cleanStr(raw, 40); if (!text) continue;
        if (scanProfileText(text)) throw new HttpError(400, 'Favourites can’t contain links or contact details.');
        favs.push({ cat: c.id, text, norm: normalizeText(text) });
      }
    }
    tx(db, () => {
      db.prepare('UPDATE users SET display_name=?, bio=?, city=?, lat=?, lng=?, radius_km=?, onboarded=1, batch_json=? WHERE id=?')
        .run(name, bio, city, Math.round(lat * 100) / 100, Math.round(lng * 100) / 100, radius, '[]', req.user.id); // ~1 km precision only
      db.prepare('DELETE FROM user_tags WHERE user_id=?').run(req.user.id);
      db.prepare('DELETE FROM user_favs WHERE user_id=?').run(req.user.id);
      db.prepare('DELETE FROM user_answers WHERE user_id=?').run(req.user.id);
      for (const t of tags) db.prepare('INSERT INTO user_tags VALUES (?,?)').run(req.user.id, t);
      for (const f of favs) db.prepare('INSERT INTO user_favs VALUES (?,?,?,?)').run(req.user.id, f.cat, f.text, f.norm);
      for (const q of QUESTIONS) db.prepare('INSERT INTO user_answers VALUES (?,?,?)').run(req.user.id, q.id, ANSWER_VALUES[answers[q.id]]);
    });
    res.json({ ok: true, user: myProfile(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
  }));

  // ---- geocoding (server-side proxy to fixed OSM hosts; never takes a URL from the client) ----
  const geoLimit = lim(60_000, 15, 'Too many location searches — wait a moment.', byUser);
  const osmGet = async (url) => {
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'PeopleLikeMe/1.0 (friend-matching)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error(`osm ${r.status}`);
    return r.json();
  };
  app.get('/api/geocode', requireUser, geoLimit, wrap(async (req, res) => {
    const q = cleanStr(req.query.q, 80);
    if (q.length < 2) return res.json({ results: [] });
    try {
      const j = await osmGet(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=0&q=${encodeURIComponent(q)}`);
      res.json({ results: j.map((x) => ({ label: String(x.display_name).slice(0, 100), lat: Math.round(+x.lat * 100) / 100, lng: Math.round(+x.lon * 100) / 100 })) });
    } catch { throw new HttpError(502, 'Location search is unavailable. Try “Use my location” instead.'); }
  }));
  app.get('/api/geocode/reverse', requireUser, geoLimit, wrap(async (req, res) => {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Bad coordinates.');
    try {
      const j = await osmGet(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}`);
      const a = j.address || {};
      res.json({ city: cleanStr(a.city || a.town || a.village || a.suburb || a.county || '', 60) });
    } catch { res.json({ city: '' }); }
  }));

  // ---- privacy: export & delete ----
  app.get('/api/account/export', requireUser, wrap(async (req, res) => {
    const u = req.user;
    const rows = (sql) => db.prepare(sql).all(u.id);
    res.setHeader('Content-Disposition', 'attachment; filename="peoplelikeme-my-data.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      account: { email: u.email, displayName: u.display_name, dateOfBirth: u.dob, city: u.city, approxLat: u.lat, approxLng: u.lng, radiusKm: u.radius_km, bio: u.bio, createdAt: new Date(u.created_at).toISOString() },
      interests: rows('SELECT tag FROM user_tags WHERE user_id = ?').map((r) => r.tag),
      favourites: rows('SELECT cat, text FROM user_favs WHERE user_id = ?'),
      answers: rows('SELECT qid, val FROM user_answers WHERE user_id = ?'),
      messagesSent: rows('SELECT chat_id, body, created_at FROM messages WHERE sender_id = ?'),
      reportsIFiled: rows('SELECT category, description, status, created_at FROM reports WHERE reporter_id = ?'),
    });
  }));
  app.delete('/api/account', authLimiter, requireUser, wrap(async (req, res) => {
    if (!(await A.verifyPassword(String(req.body?.password || ''), req.user.pw_hash))) throw new HttpError(401, 'Password is incorrect.');
    // Keep an irreversible hash only for people with upheld reports, so banned scammers can't simply re-register.
    const upheld = db.prepare("SELECT 1 FROM reports WHERE reported_id = ? AND status = 'upheld'").get(req.user.id);
    tx(db, () => {
      if (upheld) db.prepare('INSERT OR IGNORE INTO email_blocklist VALUES (?,?,?)').run(req.user.email_hash, 'upheld-report', Date.now());
      db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    });
    res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true });
  }));

  social.mount(app, { db, wrap, HttpError, requireReady, requireUser, lim, byUser, cleanStr, fetchImpl });

  // ---- static site ----
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: PROD ? '1h' : 0, index: 'index.html' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Bad request.' });
    if (!(err instanceof HttpError)) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on our side.', code: err.code });
  });
  return app;
}

module.exports = { createApp, HttpError };
