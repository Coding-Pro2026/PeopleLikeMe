'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../server/matching/engine');
const { QUESTIONS } = require('../server/data/questions');
const { candidateVenueTypes, pickVenueType, surpriseSpot } = require('../server/matching/spot');
const { scanMessage } = require('../server/safety');

const allAns = (v) => Object.fromEntries(QUESTIONS.map((q) => [q.id, v]));
const person = (id, tags, answers, favs = [], extra = {}) => ({
  id, tags, answers, favs: favs.map(([cat, text]) => ({ cat, text, norm: E.normalizeText(text) })), lat: 19.07, lng: 72.87, radiusKm: 25, prefs: {}, ...extra,
});
const idfFor = (...ps) => E.buildIdf(ps);

test('score is symmetric and within 0..100', () => {
  const a = person(1, ['movies:scifi', 'food:ramen', 'hobby:gaming'], allAns(1));
  const b = person(2, ['movies:fantasy', 'food:ramen', 'music:lofi'], { ...allAns(0), q_deep: 1 });
  const idf = idfFor(a, b);
  const ab = E.pairScore(a, b, idf), ba = E.pairScore(b, a, idf);
  assert.equal(ab.total, ba.total);
  assert.ok(ab.total >= 0 && ab.total <= 100);
});

test('identical people score very high, opposites very low', () => {
  const a = person(1, ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:ost', 'hobby:coding'], allAns(1));
  const twin = person(2, [...a.tags], allAns(1));
  const opposite = person(3, ['music:classical', 'hobby:climbing', 'food:bbq'], allAns(0));
  const idf = idfFor(a, twin, opposite);
  assert.ok(E.pairScore(a, twin, idf).total >= 90);
  assert.ok(E.pairScore(a, opposite, idf).total <= 15);
});

test('rare shared interests outweigh common shared interests', () => {
  const me = person(1, ['food:pizza', 'music:classical'], allAns(0.5));
  const common = person(2, ['food:pizza', 'hobby:climbing'], allAns(0.5));
  const rare = person(3, ['music:classical', 'hobby:climbing'], allAns(0.5));
  const idf = idfFor(me, common, rare);
  assert.ok(E.pairScore(me, rare, idf).interests > E.pairScore(me, common, idf).interests);
});

test('related interests earn partial credit (anime ~ manga)', () => {
  const me = person(1, ['movies:anime', 'food:pizza'], allAns(0.5));
  const related = person(2, ['books:manga', 'food:bbq'], allAns(0.5));
  const unrelated = person(3, ['hobby:climbing', 'food:bbq'], allAns(0.5));
  const idf = idfFor(me, related, unrelated);
  assert.ok(E.pairScore(me, related, idf).interests > E.pairScore(me, unrelated, idf).interests);
});

test('long interest lists are not favoured (no keyword stuffing)', () => {
  const me = person(1, ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:lofi', 'hobby:reading'], allAns(1));
  const focused = person(2, ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:lofi', 'hobby:reading'], allAns(1));
  const stuffer = person(3, Object.keys(require('../server/data/taxonomy').TAGS).slice(0, 30).concat(me.tags), allAns(1));
  const idf = idfFor(me, focused, stuffer);
  assert.ok(E.pairScore(me, focused, idf).total > E.pairScore(me, stuffer, idf).total);
});

test('typed favourites match fuzzily', () => {
  const a = person(1, ['movies:animation', 'food:pizza', 'hobby:yoga'], allAns(0.5), [['movie', 'Spirited Away']]);
  const b = person(2, ['movies:animation', 'food:bbq', 'hobby:dogs'], allAns(0.5), [['movie', 'spirited away (2001)']]);
  const c = person(3, ['movies:animation', 'food:bbq', 'hobby:dogs'], allAns(0.5), [['movie', 'The Matrix']]);
  const idf = idfFor(a, b, c);
  assert.equal(E.pairScore(a, b, idf).sharedFavs.length, 1);
  assert.equal(E.pairScore(a, c, idf).sharedFavs.length, 0);
  assert.ok(E.pairScore(a, b, idf).interests > E.pairScore(a, c, idf).interests);
});

test('"maybe" everywhere gives a middling, low-confidence result — not a top match', () => {
  const a = person(1, ['food:pizza'], allAns(1));
  const maybe = person(2, ['food:pizza'], allAns(0.5));
  const same = person(3, ['food:pizza'], allAns(1));
  const idf = idfFor(a, maybe, same);
  assert.ok(E.pairScore(a, same, idf).total > E.pairScore(a, maybe, idf).total);
});

test('flex questions (planner vs spontaneous) hurt less than values questions', () => {
  const base = allAns(1);
  const flexDiff = { ...base, q_plan: 0, q_routine: 0, q_night: 0 };
  const valuesDiff = { ...base, q_kind: 0, q_deep: 0, q_recharge: 0 };
  const a = person(1, ['food:pizza'], base);
  const idf = idfFor(a);
  assert.ok(E.personalityScore(a, person(2, [], flexDiff)).P > E.personalityScore(a, person(3, [], valuesDiff)).P);
});

test('explanations name shared vibe & interests and offer starters', () => {
  const a = person(1, ['movies:scifi', 'food:ramen'], allAns(1), [['movie', 'Interstellar']]);
  const b = person(2, ['movies:scifi', 'food:ramen'], allAns(1), [['movie', 'Interstellar']]);
  const ex = E.explain(E.pairScore(a, b, idfFor(a, b)));
  assert.match(ex.headline, /both/);
  assert.match(ex.headline, /Interstellar|Sci-fi|Ramen/);
  assert.ok(ex.starters.length >= 2);
});

function crowd(n, near = true) {
  const tagsAll = Object.keys(require('../server/data/taxonomy').TAGS);
  return Array.from({ length: n }, (_, i) => person(100 + i, [0, 1, 2, 3, 4, 5].map((k) => tagsAll[(i * 7 + k * 13) % tagsAll.length]),
    Object.fromEntries(QUESTIONS.map((q, j) => [q.id, [0, 0.5, 1][(i + j * 2) % 3]])), [],
    { lat: 19.07 + (near ? (i % 10) * 0.01 : 5 + i), lng: 72.87 + (near ? (i % 7) * 0.01 : 5) }));
}

test('ranking returns at most 10, sorted sensibly, unique, with scores', () => {
  const me = person(1, ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:lofi', 'hobby:reading'], allAns(1));
  const out = E.rankCandidates(me, crowd(80));
  assert.ok(out.length <= 10 && out.length > 0);
  assert.equal(new Set(out.map((o) => o.profile.id)).size, out.length);
  for (const o of out) assert.ok(o.score.total >= 0 && o.score.total <= 100);
});

test('ranking respects both people’s distance limits', () => {
  const me = person(1, ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:lofi', 'hobby:reading'], allAns(1), [], { radiusKm: 10 });
  const far = crowd(20, false);
  assert.equal(E.rankCandidates(me, far).length, 0);
  const shy = person(500, me.tags, allAns(1), [], { lat: 19.07 + 0.15, lng: 72.87, radiusKm: 5 }); // ~16km, outside HER 5km radius
  assert.equal(E.rankCandidates(me, [shy]).length, 0);
});

test('diversity: shortlist is not ten clones', () => {
  const me = person(1, ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:lofi', 'hobby:reading'], allAns(1));
  const clones = Array.from({ length: 12 }, (_, i) => person(10 + i, ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:lofi', 'hobby:reading'], allAns(1)));
  const varied = Array.from({ length: 8 }, (_, i) => person(40 + i, ['movies:scifi', 'food:ramen', 'hobby:gaming', ['music:folk', 'hobby:hiking', 'food:baking', 'books:poetry'][i % 4], ['hobby:cats', 'hobby:yoga'][i % 2]], allAns(1)));
  const plain = E.rankCandidates(me, [...clones, ...varied], { wildcards: 0, diversity: 0 });
  assert.ok(plain.every((o) => o.profile.id < 40), 'without diversity the near-perfect clones fill the list');
  const mixed = E.rankCandidates(me, [...clones, ...varied], { wildcards: 0, diversity: 40 });
  assert.ok(mixed.slice(0, 5).some((o) => o.profile.id >= 40), 'with diversity, varied people reach the top five');
  const def = E.rankCandidates(me, [...clones, ...varied], { wildcards: 0 });
  assert.ok(def.slice(0, 3).every((o) => o.profile.id < 40), 'default penalty is mild: true top matches still lead');
});

test('taste learning shifts ranking but cannot override a bad match', () => {
  const me = person(1, ['movies:scifi', 'food:ramen', 'hobby:gaming'], allAns(1), [], { prefs: { 'music:classical': -1 } });
  const a = person(2, ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:classical'], allAns(1));
  const b = person(3, ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:folk'], allAns(1));
  const out = E.rankCandidates(me, [a, b], { wildcards: 0 });
  assert.equal(out[0].profile.id, 3);
});

// ---- Surprise Spot ----
test('surprise spot never suggests a venue type either person listed under "places"', () => {
  const a = ['hobby:reading', 'place:bookstore', 'place:library', 'food:coffee', 'movies:scifi'];
  const b = ['hobby:reading', 'place:cafe', 'books:fantasy', 'food:coffee', 'movies:scifi'];
  const types = candidateVenueTypes(a, b).map((c) => c.type);
  for (const banned of ['bookstore', 'library', 'cafe']) assert.ok(!types.includes(banned), banned);
  assert.ok(types.length > 0);
  assert.ok(types.includes('cinema'));
});

test('surprise spot picks via weighted randomness and degrades gracefully offline', async () => {
  const tags = ['movies:scifi', 'hobby:gaming', 'food:ramen'];
  const cands = candidateVenueTypes(tags, tags);
  assert.equal(pickVenueType(cands, () => 0).type, cands[0].type);
  const a = { tags, lat: 19.07, lng: 72.87 }, b = { tags, lat: 19.1, lng: 72.9 };
  const offline = await surpriseSpot(a, b, { fetchImpl: async () => { throw new Error('down'); } });
  assert.ok(offline.label && offline.venue === null && offline.offline);
  const online = await surpriseSpot(a, b, {
    rng: () => 0.1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ elements: [{ lat: 19.08, lon: 72.88, tags: { name: 'Pixel Palace' } }] }) }),
  });
  assert.equal(online.venue.name, 'Pixel Palace');
  assert.match(online.mapUrl, /^https:\/\/www\.openstreetmap\.org\//);
});

// ---- safety ----
test('chat scanner blocks links and flags scam language', () => {
  assert.equal(scanMessage('check out www.free-money.xyz').block, true);
  assert.equal(scanMessage('http://evil.example').block, true);
  assert.ok(scanMessage('please send me a gift card urgently').flags.includes('money'));
  assert.ok(scanMessage('lets move to whatsapp').flags.includes('contact'));
  assert.deepEqual(scanMessage('I loved that movie too!'), { block: false, flags: [] });
});
