'use strict';
/**
 * PeopleLikeMe "Vibe Engine"
 * ---------------------------------------------------------------------------
 * Pure functions only (no I/O) so everything here is unit-testable.
 *
 *   vibe = f(personality, interests, shared favourites, confidence)
 *
 *  1. PERSONALITY  – weighted, confidence-aware agreement over Yes/Maybe/No
 *                    answers. "Flex" questions (planner vs spontaneous) are
 *                    penalised half as hard: opposites can click there.
 *  2. INTERESTS    – IDF-weighted cosine over interest tags. Sharing a rare
 *                    interest (Classical & jazz) counts far more than a common
 *                    one (Pizza). Related tags (Anime ~ Manga) earn partial
 *                    credit through "clusters". Saturating curve so people with
 *                    long lists are not favoured.
 *  3. FAVOURITES   – fuzzy (character-trigram) matches of typed favourites:
 *                    "spirited away" ~ "Spirited Away (2001)".
 *  4. BLEND        – 60% arithmetic + 40% geometric mean of (P, I), so a great
 *                    score needs BOTH vibe and interests; one can't carry it.
 *  5. CONFIDENCE   – shrinks toward 50 when little evidence exists (many
 *                    "maybe" answers), so thin profiles don't top the list.
 *
 * The score is symmetric: score(a, b) === score(b, a). Both people see the
 * same number.
 *
 * Ranking then adds distance, learned taste, diversity (MMR) and "wildcard"
 * slots, see rankCandidates().
 */
const { TAGS } = require('../data/taxonomy');
const { QUESTIONS, QUESTION_MAP } = require('../data/questions');

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// ---------- text helpers ---------------------------------------------------
function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // "(2001)"
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|of)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function trigrams(s) {
  const p = `  ${s} `; const out = new Map();
  for (let i = 0; i < p.length - 2; i++) { const g = p.slice(i, i + 3); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}
function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = trigrams(a), B = trigrams(b);
  let inter = 0, sa = 0, sb = 0;
  for (const [g, n] of A) { sa += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
  for (const n of B.values()) sb += n;
  return sa + sb === 0 ? 0 : (2 * inter) / (sa + sb);
}

// ---------- geo ------------------------------------------------------------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------- rarity weights (IDF) ------------------------------------------
const PRIOR_STRENGTH = 20; // pseudo-users backing the taxonomy's popularity prior
/** Builds tag -> weight. Blends the curated prior with real usage as the community grows. */
function buildIdf(profiles) {
  const N = profiles.length, df = new Map();
  for (const p of profiles) for (const t of p.tags) df.set(t, (df.get(t) || 0) + 1);
  const cache = new Map();
  return (tag) => {
    if (cache.has(tag)) return cache.get(tag);
    const prior = TAGS[tag]?.pop ?? 0.4;
    const f = clamp(((df.get(tag) || 0) + PRIOR_STRENGTH * prior) / (N + PRIOR_STRENGTH), 0.02, 0.95);
    const w = 0.3 + Math.log(1 / f);
    cache.set(tag, w);
    return w;
  };
}

// ---------- personality ---------------------------------------------------
function personalityScore(a, b) {
  let num = 0, den = 0; const agreements = [];
  for (const q of QUESTIONS) {
    const x = a.answers[q.id], y = b.answers[q.id];
    if (x === undefined || y === undefined) continue;
    const diff = Math.abs(x - y);
    const agree = 1 - (q.mode === 'flex' ? 0.5 : 1) * diff;
    // "Maybe" carries little information, so it counts for less.
    const conf = x === 0.5 && y === 0.5 ? 0.6 : (x === 0.5 || y === 0.5 ? 0.85 : 1);
    num += q.w * conf * agree; den += q.w * conf;
    if (x === y && x !== 0.5) agreements.push({ id: q.id, answer: x, weight: q.w, dim: q.dim });
  }
  if (den === 0) return { P: 0.5, evidence: 0, agreements };
  const raw = num / den;
  // Random pairs average ~0.6 raw agreement; stretch so scores use the full range.
  return { P: clamp((raw - 0.35) / 0.6), evidence: den, agreements };
}

// ---------- interests -----------------------------------------------------
function interestScore(a, b, idf) {
  const A = new Set(a.tags), B = new Set(b.tags);
  let num = 0, na = 0, nb = 0;
  const shared = [];
  for (const t of A) na += idf(t) ** 2;
  for (const t of B) nb += idf(t) ** 2;
  for (const t of A) if (B.has(t)) { num += idf(t) ** 2; shared.push({ tag: t, weight: idf(t) }); }

  // Soft credit: unmatched tags that live in the same cluster (anime ~ manga).
  const restA = [...A].filter((t) => !B.has(t) && TAGS[t] && TAGS[t].cluster !== 'p');
  const restB = new Set([...B].filter((t) => !A.has(t) && TAGS[t] && TAGS[t].cluster !== 'p'));
  const soft = [];
  for (const x of restA.sort((m, n) => idf(n) - idf(m))) {
    let best = null;
    for (const y of restB) if (TAGS[y].cluster === TAGS[x].cluster && (!best || idf(y) > idf(best))) best = y;
    if (best) { restB.delete(best); num += 0.3 * idf(x) * idf(best); soft.push([x, best]); }
  }
  const cos = na && nb ? clamp(num / Math.sqrt(na * nb)) : 0;
  let I = 1 - Math.exp(-3.5 * cos);

  // Typed favourites: fuzzy matched, capped bonus.
  const sharedFavs = [];
  for (const fa of a.favs || []) for (const fb of b.favs || []) {
    if (fa.cat !== fb.cat) continue;
    if (diceSimilarity(fa.norm, fb.norm) >= 0.8) sharedFavs.push({ cat: fa.cat, text: fa.text });
  }
  const bonus = Math.min(0.25, 0.1 * sharedFavs.length);
  I = I + bonus * (1 - I);
  shared.sort((m, n) => n.weight - m.weight);
  return { I: clamp(I), shared, soft, sharedFavs };
}

// ---------- the blended vibe score ----------------------------------------
function pairScore(a, b, idf) {
  const pers = personalityScore(a, b);
  const int = interestScore(a, b, idf);
  const P = pers.P, I = int.I;
  const arith = 0.55 * P + 0.45 * I;
  const geo = Math.pow(Math.max(P, 0.02), 0.55) * Math.pow(Math.max(I, 0.02), 0.45);
  let v = 0.6 * arith + 0.4 * geo;
  const confidence = pers.evidence / (pers.evidence + 1);
  v = confidence * v + (1 - confidence) * 0.5;
  return {
    total: Math.round(clamp(v) * 100),
    raw: v,
    personality: Math.round(P * 100),
    interests: Math.round(I * 100),
    P, I,
    sharedTags: int.shared, softPairs: int.soft, sharedFavs: int.sharedFavs, agreements: pers.agreements,
  };
}

/** Cosine between two people's exact-tag vectors (used for diversity in the shortlist). */
function tagSimilarity(a, b, idf) {
  const B = new Set(b.tags); let num = 0, na = 0, nb = 0;
  for (const t of a.tags) { na += idf(t) ** 2; if (B.has(t)) num += idf(t) ** 2; }
  for (const t of b.tags) nb += idf(t) ** 2;
  return na && nb ? num / Math.sqrt(na * nb) : 0;
}

// ---------- ranking -------------------------------------------------------
/**
 * me:        {id, tags[], favs[], answers{}, lat, lng, radiusKm, prefs{tag:weight}}
 * pool:      candidate profiles (already filtered for safety/blocks/etc. by the caller)
 * opts:      {limit=10, wildcards=2, minScore=30, diversity=10}  (diversity = MMR penalty in score points)
 * Returns up to `limit` entries, best first, each with the full explanation inputs.
 */
function rankCandidates(me, pool, opts = {}) {
  const { limit = 10, wildcards = 2, minScore = 30, diversity = 10 } = opts;
  const idf = opts.idf || buildIdf([me, ...pool]);

  const scored = [];
  for (const c of pool) {
    if (c.id === me.id) continue;
    const hasGeo = me.lat != null && c.lat != null;
    const dist = hasGeo ? haversineKm(me.lat, me.lng, c.lat, c.lng) : null;
    const R = Math.min(me.radiusKm || 25, c.radiusKm || 25);
    if (dist != null && dist > R) continue;                 // must be within BOTH people's radius
    const s = pairScore(me, c, idf);
    const prox = dist == null ? 0.5 : Math.exp(-dist / (0.6 * R));
    // Learned taste: gentle nudge (<= ±6 pts) from past waves / passes / refreshes.
    let taste = 0;
    if (me.prefs) { for (const t of c.tags) taste += me.prefs[t] || 0; taste = clamp(taste / Math.sqrt(Math.max(1, c.tags.length)), -1, 1) * 6; }
    const rank = s.total * (0.8 + 0.2 * prox) + taste;
    scored.push({ profile: c, score: s, distanceKm: dist, rank });
  }
  const viable = scored.filter((x) => x.score.total >= minScore).sort((a, b) => b.rank - a.rank);
  const pickable = viable.length >= Math.min(limit, 4) ? viable : scored.sort((a, b) => b.rank - a.rank);

  // Maximal-marginal-relevance: avoid 10 near-identical people.
  const LAMBDA = diversity, mainSlots = Math.max(0, limit - wildcards);
  const shortlist = pickable.slice(0, 40), chosen = [];
  while (chosen.length < mainSlots && shortlist.length) {
    let bi = 0, bv = -Infinity;
    shortlist.forEach((x, i) => {
      let sim = 0;
      for (const c of chosen) sim = Math.max(sim, tagSimilarity(x.profile, c.profile, idf));
      const v = x.rank - LAMBDA * sim;
      if (v > bv) { bv = v; bi = i; }
    });
    chosen.push({ ...shortlist.splice(bi, 1)[0], slot: 'top' });
  }
  // Wildcards: strong personality fit, different interests -> a "you'd never have searched for them" pick.
  const rest = pickable.filter((x) => !chosen.includes(x) && !chosen.some((c) => c.profile.id === x.profile.id));
  const wild = rest
    .filter((x) => x.score.P >= 0.7 && x.score.total >= Math.max(minScore, 40))
    .sort((a, b) => (b.score.P - 0.6 * b.score.I) - (a.score.P - 0.6 * a.score.I))
    .slice(0, wildcards).map((x) => ({ ...x, slot: 'wildcard' }));
  const out = [...chosen, ...wild];
  // If wildcards were not available, fill with the next-best normal picks.
  for (const x of rest) { if (out.length >= limit) break; if (!out.some((o) => o.profile.id === x.profile.id)) out.push({ ...x, slot: 'top' }); }
  return out.slice(0, limit);
}

/** Taste learning: returns new prefs after an event on a candidate's tags. */
function updatePrefs(prefs, tags, delta) {
  const next = { ...prefs };
  for (const t of tags) next[t] = clamp((next[t] || 0) * 0.98 + delta, -1, 1);
  return next;
}

// ---------- explanation ---------------------------------------------------
const STARTER_TEMPLATES = {
  movies: (l) => `You both enjoy ${l.toLowerCase()} — what’s one you could rewatch forever?`,
  music: (l) => `You’re both into ${l} — what’s been on repeat lately?`,
  food: (l) => `${l} fans! What’s your go-to order?`,
  hobbies: (l) => `You’re both into ${l.toLowerCase()} — how did you get started?`,
  books: (l) => `You both like ${l.toLowerCase()} — what should the other read first?`,
  places: (l) => `You both love ${l.toLowerCase()} — what’s your favourite one nearby?`,
};
const FAV_CAT_LABEL = { movie: 'movie/show', food: 'food', place: 'place', music: 'music', book: 'book/game' };
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} & ${xs[xs.length - 1]}`);

/** Human reasons + conversation starters for a scored pair. */
function explain(score) {
  const topAgree = [...score.agreements].sort((a, b) => b.weight - a.weight);
  const seenDims = new Set(), vibes = [];
  for (const g of topAgree) {
    if (seenDims.has(g.dim)) continue;
    seenDims.add(g.dim);
    const q = QUESTION_MAP[g.id];
    vibes.push(g.answer === 1 ? q.yes : q.no);
    if (vibes.length === 2) break;
  }
  const tags = score.sharedTags.slice(0, 2).map((s) => TAGS[s.tag].label);
  const favs = score.sharedFavs.map((f) => f.text);

  let headline;
  if (vibes.length && (tags.length || favs.length)) {
    headline = `You’re both “${vibes.join('” & “')}” types who love ${list([...favs.slice(0, 1), ...tags].slice(0, 3).map((x) => `“${x}”`))}.`;
  } else if (vibes.length) {
    headline = `You’re both “${vibes.join('” & “')}” — that’s a rare match of temperament.`;
  } else if (tags.length || favs.length) {
    headline = `You both love ${list([...favs.slice(0, 1), ...tags].slice(0, 3).map((x) => `“${x}”`))}.`;
  } else {
    headline = 'Your personalities are complementary — a fresh perspective could be fun.';
  }

  const starters = [];
  for (const f of score.sharedFavs.slice(0, 1)) starters.push(`You both love “${f.text}” (${FAV_CAT_LABEL[f.cat]}) — what got you into it?`);
  for (const s of score.sharedTags.slice(0, 2)) {
    const t = TAGS[s.tag]; starters.push(STARTER_TEMPLATES[t.group](t.label));
  }
  for (const g of topAgree.slice(0, 2)) starters.push(QUESTION_MAP[g.id].starter);
  if (!starters.length) starters.push('What’s something small that made you smile this week?');
  return { headline, vibes, sharedLabels: score.sharedTags.map((s) => TAGS[s.tag].label), starters: starters.slice(0, 4) };
}

module.exports = {
  normalizeText, diceSimilarity, haversineKm, buildIdf,
  personalityScore, interestScore, pairScore, tagSimilarity,
  rankCandidates, updatePrefs, explain,
};
