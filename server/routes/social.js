'use strict';
const A = require('../auth');
const { tx } = require('../db');
const E = require('../matching/engine');
const { surpriseSpot } = require('../matching/spot');
const { scanMessage } = require('../safety');
const { loadProfiles, publicCard, placeholders, DAY } = require('../profiles');

const REPORT_CATEGORIES = ['scam', 'fake-profile', 'harassment', 'underage', 'inappropriate', 'other'];
const AUTO_SUSPEND_REPORTERS = 3;
const SAFETY_TIPS = [
  'Meet in a public place, in daylight, for your first few meetups.',
  'Tell someone you trust where you’re going and when.',
  'Arrange your own transport. Never accept a ride from someone you just met.',
  'Never send money, gift cards or crypto — not for an emergency, not ever.',
  'Trust your gut. It’s always fine to leave, or to say “not today”.',
];

function mount(app, { db, wrap, HttpError, requireReady, requireUser, lim, byUser, cleanStr, fetchImpl }) {
  const now = () => Date.now();
  const byPid = (pid) => {
    const u = db.prepare('SELECT * FROM users WHERE pid = ? AND status = ?').get(String(pid || '').slice(0, 24), 'active');
    if (!u) throw new HttpError(404, 'That person isn’t available.');
    return u;
  };
  const isBlocked = (a, b) => !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a, b, b, a);
  const pair = (a, b) => (a < b ? [a, b] : [b, a]);
  const getChat = (a, b) => { const [x, y] = pair(a, b); return db.prepare('SELECT * FROM chats WHERE a_id=? AND b_id=?').get(x, y); };
  const adjustPrefs = (userId, tags, delta) => {
    for (const t of tags) {
      const cur = db.prepare('SELECT w FROM tag_prefs WHERE user_id=? AND tag=?').get(userId, t)?.w ?? 0;
      const next = Math.max(-1, Math.min(1, cur * 0.98 + delta));
      db.prepare('INSERT INTO tag_prefs VALUES (?,?,?) ON CONFLICT(user_id, tag) DO UPDATE SET w=excluded.w').run(userId, t, next);
    }
  };

  // ---------------- discovery ----------------
  /** Everyone who may legitimately be suggested to `me`. */
  function eligibleIds(me, { excludeSeen }) {
    const box = (me.radius_km || 25) * 1.0;
    const dLat = box / 111, dLng = box / (111 * Math.max(0.2, Math.cos((me.lat * Math.PI) / 180)));
    return db.prepare(`
      SELECT u.id FROM users u
      WHERE u.id != ? AND u.status='active' AND u.email_verified=1 AND u.onboarded=1
        AND u.lat BETWEEN ? AND ? AND u.lng BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=u.id AND b.blocked_id=?1) OR (b.blocker_id=?1 AND b.blocked_id=u.id))
        AND NOT EXISTS (SELECT 1 FROM waves w WHERE (w.from_id=?1 AND w.to_id=u.id) OR (w.from_id=u.id AND w.to_id=?1))
        AND NOT EXISTS (SELECT 1 FROM chats c WHERE (c.a_id=?1 AND c.b_id=u.id) OR (c.b_id=?1 AND c.a_id=u.id))
        ${excludeSeen ? 'AND NOT EXISTS (SELECT 1 FROM seen s WHERE s.user_id=?1 AND s.other_id=u.id)' : ''}
    `).all(me.id, me.lat - dLat, me.lat + dLat, me.lng - dLng, me.lng + dLng).map((r) => r.id);
  }
  function buildBatch(meRow, { excludeSeen }) {
    const ids = eligibleIds(meRow, { excludeSeen });
    const profiles = loadProfiles(db, [meRow.id, ...ids]);
    const me = profiles.get(meRow.id);
    const pool = ids.map((i) => profiles.get(i)).filter((p) => p && p.answers && Object.keys(p.answers).length && p.tags.length);
    const ranked = E.rankCandidates(me, pool, { limit: 10, wildcards: 2 });
    db.prepare('UPDATE users SET batch_json=? WHERE id=?').run(JSON.stringify(ranked.map((r) => ({ id: r.profile.id, slot: r.slot }))), meRow.id);
    return ranked.length;
  }
  function presentBatch(meRow) {
    const stored = JSON.parse(meRow.batch_json || '[]');
    const profiles = loadProfiles(db, [meRow.id, ...stored.map((s) => s.id)]);
    const me = profiles.get(meRow.id);
    const eligible = new Set(eligibleIds(meRow, { excludeSeen: false }));
    const live = stored.filter((s) => eligible.has(s.id) && profiles.has(s.id));
    const idf = E.buildIdf([me, ...live.map((s) => profiles.get(s.id))]);
    return live.map((s) => {
      const o = profiles.get(s.id);
      const dist = E.haversineKm(me.lat, me.lng, o.lat, o.lng);
      return publicCard(db, o, E.pairScore(me, o, idf), dist, { slot: s.slot });
    });
  }

  app.get('/api/matches', requireReady, wrap(async (req, res) => {
    let cards = presentBatch(req.user);
    if (!cards.length) { buildBatch(req.user, { excludeSeen: true }); cards = presentBatch(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)); }
    res.json({ matches: cards, communitySize: db.prepare("SELECT COUNT(*) c FROM users WHERE status='active' AND onboarded=1 AND email_verified=1").get().c });
  }));

  app.post('/api/matches/refresh', lim(60_000, 20, 'Easy there — give it a minute before refreshing again.', byUser), requireReady, wrap(async (req, res) => {
    const batch = JSON.parse(req.user.batch_json || '[]');
    const shownTags = loadProfiles(db, batch.map((b) => b.id));
    tx(db, () => {
      for (const b of batch) {
        db.prepare('INSERT OR REPLACE INTO seen VALUES (?,?,?)').run(req.user.id, b.id, now());
        // "Refresh" is a soft "not quite my type": nudge down their distinctive tags.
        adjustPrefs(req.user.id, shownTags.get(b.id)?.tags ?? [], -0.04);
      }
    });
    const fresh = () => db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    let recycled = false;
    let n = buildBatch(fresh(), { excludeSeen: true });
    if (n < 3) { // seen everyone nearby: start a new round
      db.prepare('DELETE FROM seen WHERE user_id=?').run(req.user.id); recycled = true;
      n = buildBatch(fresh(), { excludeSeen: false });
    }
    db.prepare('UPDATE users SET refreshes = refreshes + 1 WHERE id=?').run(req.user.id);
    res.json({ matches: presentBatch(fresh()), recycled });
  }));

  // ---------------- waves (mutual opt-in) ----------------
  const waveLimit = (u) => (now() - u.created_at < 7 * DAY ? 8 : 25);
  app.post('/api/wave', lim(60_000, 30, 'Slow down a little.', byUser), requireReady, wrap(async (req, res) => {
    const other = byPid(req.body?.pid);
    if (!other.email_verified || !other.onboarded) throw new HttpError(404, 'That person isn’t available.');
    if (other.id === req.user.id) throw new HttpError(400, 'That’s you!');
    if (isBlocked(req.user.id, other.id)) throw new HttpError(404, 'That person isn’t available.');
    if (db.prepare('SELECT 1 FROM waves WHERE from_id=? AND to_id=?').get(req.user.id, other.id)) throw new HttpError(409, 'You already waved at this person.');
    const sentToday = db.prepare('SELECT COUNT(*) c FROM waves WHERE from_id=? AND created_at > ?').get(req.user.id, now() - DAY).c;
    if (sentToday >= waveLimit(req.user)) throw new HttpError(429, 'You’ve reached today’s wave limit — quality over quantity! Try again tomorrow.');
    const note = cleanStr(req.body?.note, 140);
    if (note) { const scan = scanMessage(note); if (scan.block) throw new HttpError(400, scan.reason); }
    const reverse = db.prepare("SELECT * FROM waves WHERE from_id=? AND to_id=? AND status='pending'").get(other.id, req.user.id);
    const meP = loadProfiles(db, [req.user.id, other.id]);
    adjustPrefs(req.user.id, meP.get(other.id)?.tags ?? [], 0.15);
    let chatId = null;
    tx(db, () => {
      db.prepare('INSERT INTO waves (from_id, to_id, status, note, created_at) VALUES (?,?,?,?,?)').run(req.user.id, other.id, reverse ? 'matched' : 'pending', note, now());
      if (reverse) {
        db.prepare("UPDATE waves SET status='matched' WHERE from_id=? AND to_id=?").run(other.id, req.user.id);
        const [a, b] = pair(req.user.id, other.id);
        chatId = db.prepare('INSERT INTO chats (a_id, b_id, created_at) VALUES (?,?,?)').run(a, b, now()).lastInsertRowid;
        for (const [sender, text, t] of [[other.id, reverse.note, reverse.created_at], [req.user.id, note, now()]]) {
          if (text) db.prepare('INSERT INTO messages (chat_id, sender_id, body, created_at) VALUES (?,?,?,?)').run(chatId, sender, text, t);
        }
      }
    });
    res.json({ ok: true, matched: !!reverse, chatId: chatId ? Number(chatId) : null });
  }));

  app.post('/api/pass', requireReady, wrap(async (req, res) => {
    const other = byPid(req.body?.pid);
    const p = loadProfiles(db, [other.id]).get(other.id);
    tx(db, () => {
      db.prepare("INSERT INTO waves (from_id,to_id,status,created_at) VALUES (?,?,'passed',?) ON CONFLICT(from_id,to_id) DO NOTHING").run(req.user.id, other.id, now());
      db.prepare("UPDATE waves SET status='passed' WHERE from_id=? AND to_id=? AND status='pending'").run(other.id, req.user.id);
      adjustPrefs(req.user.id, p?.tags ?? [], -0.2);
    });
    res.json({ ok: true });
  }));

  app.get('/api/waves', requireReady, wrap(async (req, res) => {
    const rows = db.prepare(`SELECT w.*, u.pid FROM waves w JOIN users u ON u.id = w.from_id
      WHERE w.to_id=? AND w.status='pending' AND u.status='active' ORDER BY w.created_at DESC LIMIT 50`).all(req.user.id)
      .filter((w) => !isBlocked(req.user.id, w.from_id));
    const profiles = loadProfiles(db, [req.user.id, ...rows.map((r) => r.from_id)]);
    const me = profiles.get(req.user.id);
    const idf = E.buildIdf([...profiles.values()]);
    const incoming = rows.map((r) => {
      const o = profiles.get(r.from_id);
      return publicCard(db, o, E.pairScore(me, o, idf), E.haversineKm(me.lat, me.lng, o.lat, o.lng), { note: r.note, wavedAt: r.created_at });
    });
    const outgoing = db.prepare("SELECT COUNT(*) c FROM waves WHERE from_id=? AND status='pending'").get(req.user.id).c;
    res.json({ incoming, outgoingPending: outgoing });
  }));

  // ---------------- chat ("the coatroom") ----------------
  const chatFor = (req) => {
    const id = Number(req.params.id);
    const chat = Number.isInteger(id) ? db.prepare('SELECT * FROM chats WHERE id=?').get(id) : null;
    if (!chat || (chat.a_id !== req.user.id && chat.b_id !== req.user.id)) throw new HttpError(404, 'Chat not found.');
    const otherId = chat.a_id === req.user.id ? chat.b_id : chat.a_id;
    if (isBlocked(req.user.id, otherId)) throw new HttpError(404, 'Chat not found.');
    return { chat, otherId, mine: chat.a_id === req.user.id ? 'a_read' : 'b_read' };
  };

  app.get('/api/chats', requireReady, wrap(async (req, res) => {
    const chats = db.prepare('SELECT * FROM chats WHERE a_id=? OR b_id=? ORDER BY id DESC').all(req.user.id, req.user.id);
    const others = chats.map((c) => (c.a_id === req.user.id ? c.b_id : c.a_id));
    const profiles = loadProfiles(db, [req.user.id, ...others]);
    const me = profiles.get(req.user.id);
    const idf = E.buildIdf([...profiles.values()]);
    const out = chats.filter((c) => !isBlocked(req.user.id, c.a_id === req.user.id ? c.b_id : c.a_id)).map((c) => {
      const oid = c.a_id === req.user.id ? c.b_id : c.a_id; const o = profiles.get(oid);
      if (!o) return null;
      const read = c.a_id === req.user.id ? c.a_read : c.b_read;
      const last = db.prepare('SELECT body, sender_id, created_at FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1').get(c.id);
      const unread = db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id=? AND id>? AND sender_id!=?').get(c.id, read, req.user.id).c;
      return { id: c.id, unread, last: last ? { text: last.body.slice(0, 80), mine: last.sender_id === req.user.id, at: last.created_at } : null,
        with: publicCard(db, o, E.pairScore(me, o, idf), E.haversineKm(me.lat, me.lng, o.lat, o.lng)) };
    }).filter(Boolean);
    res.json({ chats: out });
  }));

  app.get('/api/chats/:id/messages', requireReady, wrap(async (req, res) => {
    const { chat, mine } = chatFor(req);
    const after = Math.max(0, Number(req.query.after) || 0);
    const msgs = db.prepare('SELECT id, sender_id, body, flags, created_at FROM messages WHERE chat_id=? AND id>? ORDER BY id LIMIT 200').all(chat.id, after);
    if (msgs.length) db.prepare(`UPDATE chats SET ${mine}=? WHERE id=?`).run(msgs[msgs.length - 1].id, chat.id);
    res.json({ messages: msgs.map((m) => ({ id: m.id, mine: m.sender_id === req.user.id, text: m.body, flags: m.sender_id === req.user.id ? [] : m.flags.split(',').filter(Boolean), at: m.created_at })) });
  }));

  app.post('/api/chats/:id/messages', lim(60_000, 30, 'You’re sending messages very quickly — take a breath.', byUser), requireReady, wrap(async (req, res) => {
    const { chat, otherId } = chatFor(req);
    const text = cleanStr(req.body?.text, 1000);
    if (!text) throw new HttpError(400, 'Write something first.');
    const scan = scanMessage(text);
    if (scan.block) throw new HttpError(400, scan.reason, 'link');
    const info = db.prepare('INSERT INTO messages (chat_id, sender_id, body, flags, created_at) VALUES (?,?,?,?,?)').run(chat.id, req.user.id, text, scan.flags.join(','), now());
    // Auto-protect: repeated money/urgency pressure => hold the account for human review.
    if (scan.flags.includes('money')) {
      const hits = db.prepare("SELECT COUNT(*) c FROM messages WHERE sender_id=? AND created_at>? AND flags LIKE '%money%'").get(req.user.id, now() - DAY).c;
      if (hits >= 3) {
        db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(req.user.id);
        db.prepare("INSERT INTO reports (reporter_id, reported_id, reported_pid, reported_email_hash, category, description, created_at) VALUES (NULL,?,?,?,?,?,?)")
          .run(req.user.id, req.user.pid, req.user.email_hash, 'scam', 'AUTO: 3+ messages with money/payment language in 24h.', now());
      }
    }
    res.status(201).json({ id: Number(info.lastInsertRowid), flags: scan.flags, warning: scan.flags.length ? 'Heads up: that message looks like something scammers say. Never send money or private info to anyone online.' : undefined });
  }));

  // Surprise Spot: a random public place near the midpoint that neither listed, but both would likely enjoy.
  const lastTypes = new Map();
  app.get('/api/chats/:id/spot', lim(60_000, 10, 'Too many spot requests — try again in a moment.', byUser), requireReady, wrap(async (req, res) => {
    const { chat, otherId } = chatFor(req);
    const profiles = loadProfiles(db, [req.user.id, otherId]);
    const [me, o] = [profiles.get(req.user.id), profiles.get(otherId)];
    if (me.lat == null || o.lat == null) throw new HttpError(400, 'Both of you need a location set.');
    const key = `${chat.id}`;
    const exclude = req.query.reroll === '1' ? (lastTypes.get(key) || []).slice(-4) : [];
    const spot = await surpriseSpot(me, o, { exclude, fetchImpl });
    if (spot) lastTypes.set(key, [...exclude, spot.type]);
    if (lastTypes.size > 2000) lastTypes.clear();
    res.json({ spot, tips: SAFETY_TIPS });
  }));

  app.post('/api/chats/:id/vouch', requireReady, wrap(async (req, res) => {
    const { chat, otherId } = chatFor(req);
    const sent = (uid) => db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id=? AND sender_id=?').get(chat.id, uid).c;
    if (sent(req.user.id) < 3 || sent(otherId) < 3) throw new HttpError(400, 'Chat a bit more first — vouching is for people you genuinely got to know.');
    db.prepare('INSERT OR IGNORE INTO vouches VALUES (?,?,?)').run(req.user.id, otherId, now());
    res.json({ ok: true });
  }));

  // ---------------- block & report ----------------
  const blockUser = (blockerId, blockedId) => tx(db, () => {
    db.prepare('INSERT OR IGNORE INTO blocks VALUES (?,?,?)').run(blockerId, blockedId, now());
    const [a, b] = pair(blockerId, blockedId);
    db.prepare('DELETE FROM chats WHERE a_id=? AND b_id=?').run(a, b);
    db.prepare("UPDATE waves SET status='passed' WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)").run(blockerId, blockedId, blockedId, blockerId);
  });
  app.post('/api/block', requireUser, wrap(async (req, res) => {
    const other = db.prepare('SELECT id FROM users WHERE pid=?').get(String(req.body?.pid || '').slice(0, 24));
    if (!other || other.id === req.user.id) throw new HttpError(404, 'That person isn’t available.');
    blockUser(req.user.id, other.id); res.json({ ok: true });
  }));

  app.post('/api/report', lim(60 * 60_000, 10, 'You’ve filed several reports — our team will review them. Please try again later.', byUser), requireUser, wrap(async (req, res) => {
    const other = db.prepare('SELECT * FROM users WHERE pid=?').get(String(req.body?.pid || '').slice(0, 24));
    if (!other || other.id === req.user.id) throw new HttpError(404, 'That person isn’t available.');
    const category = String(req.body?.category || '');
    if (!REPORT_CATEGORIES.includes(category)) throw new HttpError(400, 'Choose what best describes the problem.');
    const description = cleanStr(req.body?.description, 1000);
    if (description.length < 20) throw new HttpError(400, 'Please describe what happened (at least 20 characters) so our team can act on it.');
    if (db.prepare("SELECT 1 FROM reports WHERE reporter_id=? AND reported_id=? AND status='open'").get(req.user.id, other.id)) throw new HttpError(409, 'You already reported this person — we’re looking into it.');
    let suspended = false;
    tx(db, () => {
      db.prepare('INSERT INTO reports (reporter_id, reported_id, reported_pid, reported_email_hash, category, description, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(req.user.id, other.id, other.pid, other.email_hash, category, description, now());
      blockUser(req.user.id, other.id); // reporter is protected immediately
      const distinct = db.prepare("SELECT COUNT(DISTINCT reporter_id) c FROM reports WHERE reported_id=? AND status='open' AND category IN ('scam','fake-profile','harassment','underage') AND reporter_id IS NOT NULL").get(other.id).c;
      if (distinct >= AUTO_SUSPEND_REPORTERS) { db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(other.id); suspended = true; }
    });
    res.status(201).json({ ok: true, message: 'Thank you. We’ve blocked this person for you and our team will review the report.', autoSuspended: suspended });
  }));

  app.get('/api/safety', (req, res) => res.json({ tips: SAFETY_TIPS, categories: REPORT_CATEGORIES }));
}

module.exports = { mount, REPORT_CATEGORIES };
