'use strict';
const { TAGS } = require('./data/taxonomy');
const { ageFromDob, ageBand } = require('./auth');
const { explain } = require('./matching/engine');

const DAY = 86_400_000;
const placeholders = (n) => Array(n).fill('?').join(',');

/** Loads matching-ready profiles for a list of internal user ids. */
function loadProfiles(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const ph = placeholders(ids.length);
  const users = db.prepare(`SELECT * FROM users WHERE id IN (${ph})`).all(...ids);
  for (const u of users) {
    out.set(u.id, {
      id: u.id, pid: u.pid, name: u.display_name, bio: u.bio, city: u.city, dob: u.dob, createdAt: u.created_at,
      lat: u.lat, lng: u.lng, radiusKm: u.radius_km, isDemo: !!u.is_demo, emailVerified: !!u.email_verified,
      tags: [], favs: [], answers: {}, prefs: {},
    });
  }
  for (const r of db.prepare(`SELECT * FROM user_tags WHERE user_id IN (${ph})`).all(...ids)) out.get(r.user_id)?.tags.push(r.tag);
  for (const r of db.prepare(`SELECT * FROM user_favs WHERE user_id IN (${ph})`).all(...ids)) out.get(r.user_id)?.favs.push({ cat: r.cat, text: r.text, norm: r.norm });
  for (const r of db.prepare(`SELECT * FROM user_answers WHERE user_id IN (${ph})`).all(...ids)) { const p = out.get(r.user_id); if (p) p.answers[r.qid] = r.val; }
  for (const r of db.prepare(`SELECT * FROM tag_prefs WHERE user_id IN (${ph})`).all(...ids)) { const p = out.get(r.user_id); if (p) p.prefs[r.tag] = r.w; }
  return out;
}

function trustFor(db, p) {
  const vouches = db.prepare('SELECT COUNT(*) c FROM vouches WHERE to_id = ?').get(p.id).c;
  const openReports = db.prepare("SELECT COUNT(DISTINCT reporter_id) c FROM reports WHERE reported_id = ? AND status != 'dismissed'").get(p.id).c;
  const days = Math.floor((Date.now() - p.createdAt) / DAY);
  let level = 'new';
  if (p.emailVerified && days >= 7 && openReports === 0) level = 'verified';
  if (level === 'verified' && vouches >= 3 && days >= 30) level = 'trusted';
  if (openReports > 0 && level !== 'new') level = 'under-review';
  return { level, vouches, days };
}

function distanceLabel(km) {
  if (km == null) return null;
  return km < 2 ? 'under 2 km away' : `about ${Math.round(km)} km away`;
}

/** What one user is allowed to see about another. Never includes email, dob, exact location or internal ids. */
function publicCard(db, other, scoreInfo, distanceKm, extra = {}) {
  const age = ageFromDob(other.dob);
  const card = {
    pid: other.pid, name: other.name, ageBand: age == null ? null : ageBand(age), city: other.city, bio: other.bio,
    tags: other.tags.filter((t) => TAGS[t]).map((t) => ({ id: t, label: TAGS[t].label, emoji: TAGS[t].emoji, group: TAGS[t].group })),
    favs: other.favs.map((f) => ({ cat: f.cat, text: f.text })),
    trust: trustFor(db, other),
    distance: distanceLabel(distanceKm),
    demo: other.isDemo,
    ...extra,
  };
  if (scoreInfo) {
    const ex = explain(scoreInfo);
    card.score = { total: scoreInfo.total, personality: scoreInfo.personality, interests: scoreInfo.interests };
    card.sharedTags = scoreInfo.sharedTags.map((s) => s.tag);
    card.sharedFavs = scoreInfo.sharedFavs;
    card.headline = ex.headline; card.vibes = ex.vibes; card.starters = ex.starters;
  }
  return card;
}

module.exports = { loadProfiles, trustFor, publicCard, placeholders, DAY };
