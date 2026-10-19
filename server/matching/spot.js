'use strict';
/**
 * Surprise Spot engine
 * ---------------------------------------------------------------------------
 * Picks a random PUBLIC place near the midpoint of two people that neither
 * of them listed under "Places I like to go", but that both are inferred to
 * enjoy from everything else they told us (movies, food, hobbies, books...).
 *
 *   affinity(person, venueType) = 1 - Π(1 - weight)   over their non-place tags
 *                                  (noisy-OR: more supporting interests => stronger)
 *   pair(venueType)             = sqrt(affinity(a) * affinity(b))   (geometric mean)
 *
 * Venue types either person already picked are excluded, the best 5 remaining
 * types are sampled with probability proportional to pair affinity, and then a
 * random real venue of that type is drawn from OpenStreetMap near the midpoint.
 */
const { TAGS } = require('../data/taxonomy');
const { VENUES } = require('../data/venues');
const { haversineKm } = require('./engine');

function affinity(tags) {
  const miss = {};
  for (const t of tags) {
    const tag = TAGS[t];
    if (!tag || tag.group === 'places') continue;
    for (const [venue, w] of Object.entries(tag.v)) miss[venue] = (miss[venue] ?? 1) * (1 - w);
  }
  return Object.fromEntries(Object.entries(miss).map(([k, m]) => [k, 1 - m]));
}
function explicitVenues(tags) {
  return new Set(tags.filter((t) => TAGS[t]?.group === 'places').flatMap((t) => Object.keys(TAGS[t].v)));
}

/** Ranked venue types both would likely enjoy but neither chose. */
function candidateVenueTypes(tagsA, tagsB) {
  const aa = affinity(tagsA), ab = affinity(tagsB);
  const banned = new Set([...explicitVenues(tagsA), ...explicitVenues(tagsB)]);
  return Object.keys(VENUES)
    .filter((k) => !banned.has(k) && aa[k] > 0 && ab[k] > 0)
    .map((k) => ({ type: k, affinity: Math.sqrt(aa[k] * ab[k]) }))
    .sort((x, y) => y.affinity - x.affinity);
}

/** Weighted random draw among the top candidates. `rng` is injectable for tests. */
function pickVenueType(cands, rng = Math.random, exclude = []) {
  const pool = cands.filter((c) => !exclude.includes(c.type)).slice(0, 5);
  if (!pool.length) return null;
  const total = pool.reduce((s, c) => s + c.affinity, 0);
  let r = rng() * total;
  for (const c of pool) { r -= c.affinity; if (r <= 0) return c; }
  return pool[pool.length - 1];
}

function midpoint(a, b) { return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }; }

function overpassQuery(type, mid, radiusM) {
  const parts = VENUES[type].osm.map(([k, v]) => `nwr(around:${radiusM},${mid.lat.toFixed(5)},${mid.lng.toFixed(5)})["${k}"="${v}"]["name"];`);
  return `[out:json][timeout:12];(${parts.join('')});out center 40;`;
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'; // fixed host: nothing user-supplied reaches a URL
async function fetchVenues(type, mid, radiusM, fetchImpl = fetch) {
  const res = await fetchImpl(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'PeopleLikeMe/1.0 (friend-matching; contact via site)' },
    body: 'data=' + encodeURIComponent(overpassQuery(type, mid, radiusM)),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const json = await res.json();
  return (json.elements || []).map((e) => ({
    name: String(e.tags?.name || '').slice(0, 80),
    lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon,
  })).filter((v) => v.name && Number.isFinite(v.lat) && Number.isFinite(v.lng));
}

/**
 * Returns { type, label, emoji, affinity, venue|null, mapUrl|null, why }.
 * Never throws: if the map service is unreachable you still get the *type* of place.
 */
async function surpriseSpot(a, b, { rng = Math.random, fetchImpl = fetch, exclude = [] } = {}) {
  const cands = candidateVenueTypes(a.tags, b.tags);
  const apart = haversineKm(a.lat, a.lng, b.lat, b.lng);
  const mid = midpoint(a, b);
  const radiusM = Math.round(Math.min(8, Math.max(2, apart / 2 + 1.5)) * 1000);
  // Try a few types so one empty category doesn't leave the user with nothing.
  const tried = [...exclude];
  for (let attempt = 0; attempt < 3; attempt++) {
    const pick = pickVenueType(cands, rng, tried);
    if (!pick) break;
    tried.push(pick.type);
    const meta = VENUES[pick.type];
    const base = { type: pick.type, label: meta.label, emoji: meta.emoji, affinity: Math.round(pick.affinity * 100) };
    try {
      const venues = await fetchVenues(pick.type, mid, radiusM, fetchImpl);
      if (!venues.length) continue;
      const v = venues[Math.floor(rng() * venues.length)];
      return {
        ...base, venue: { name: v.name, lat: +v.lat.toFixed(5), lng: +v.lng.toFixed(5) },
        mapUrl: `https://www.openstreetmap.org/?mlat=${v.lat.toFixed(5)}&mlon=${v.lng.toFixed(5)}#map=17/${v.lat.toFixed(5)}/${v.lng.toFixed(5)}`,
        triedTypes: tried,
      };
    } catch {
      return { ...base, venue: null, mapUrl: null, triedTypes: tried, offline: true };
    }
  }
  const first = cands[0];
  if (!first) return null;
  const meta = VENUES[first.type];
  return { type: first.type, label: meta.label, emoji: meta.emoji, affinity: Math.round(first.affinity * 100), venue: null, mapUrl: null, triedTypes: tried };
}

module.exports = { affinity, candidateVenueTypes, pickVenueType, surpriseSpot, overpassQuery, midpoint };
