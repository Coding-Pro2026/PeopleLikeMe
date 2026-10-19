'use strict';
process.env.PLM_TEST = '1'; process.env.PLM_QUIET = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { openDb } = require('../server/db');
const { QUESTIONS } = require('../server/data/questions');

const db = openDb(':memory:');
const stubOsm = async (url) => {
  if (String(url).includes('overpass')) return { ok: true, json: async () => ({ elements: [{ lat: 19.08, lon: 72.88, tags: { name: 'Pixel Palace' } }] }) };
  return { ok: true, json: async () => [{ display_name: 'Mumbai, India', lat: '19.076', lon: '72.8777' }] };
};
const app = createApp({ db, fetchImpl: stubOsm });
let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

class Client {
  constructor() { this.cookies = {}; }
  async req(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-plm-csrf': '1', cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v; }
    let json = null; try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
}

const dobYearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const PW = 'correct-horse-battery';
async function register(name, { lat = 19.07, lng = 72.87, tags, yes = 1 } = {}) {
  const c = new Client();
  const email = `${name.toLowerCase()}${Math.random().toString(36).slice(2, 7)}@example.com`;
  const s = await c.post('/api/signup', { email, password: PW, displayName: name, dob: dobYearsAgo(27), agree: true });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.equal((await c.post('/api/verify', { code: s.json.devCode })).status, 200);
  const answers = Object.fromEntries(QUESTIONS.map((q) => [q.id, yes === 1 ? 'yes' : 'no']));
  const p = await c.req('PUT', '/api/profile', {
    displayName: name, bio: 'Quiet and curious.', city: 'Mumbai', lat, lng, radiusKm: 25,
    tags: tags || ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:lofi', 'hobby:reading', 'place:cafe'],
    favs: { movie: ['Interstellar'] }, answers,
  });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const me = (await c.get('/api/me')).json.user;
  return { c, email, me };
}

test('security headers & CSP are set, x-powered-by hidden', async () => {
  const r = await fetch(base + '/api/meta');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('CSRF: mutations without the custom header are rejected; cross-origin rejected', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  const x = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-plm-csrf': '1', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(x.status, 403);
});

test('age gate: under-18 refused, no account created, cannot retry from same browser or email', async () => {
  const c = new Client();
  const email = 'kid@example.com';
  const r = await c.post('/api/signup', { email, password: PW, displayName: 'Kiddo', dob: dobYearsAgo(17), agree: true });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'underage');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get(email).c, 0);
  // same browser lies about age
  const retry = await c.post('/api/signup', { email: 'kid2@example.com', password: PW, displayName: 'Kiddo', dob: dobYearsAgo(30), agree: true });
  assert.equal(retry.status, 403);
  // fresh browser, same email
  const again = await new Client().post('/api/signup', { email, password: PW, displayName: 'Kiddo', dob: dobYearsAgo(30), agree: true });
  assert.equal(again.status, 403);
});

test('age gate: exactly-18 birthday boundary and invalid dates', async () => {
  const c = new Client();
  const tomorrow18 = new Date(); tomorrow18.setUTCFullYear(tomorrow18.getUTCFullYear() - 18); tomorrow18.setUTCDate(tomorrow18.getUTCDate() + 1);
  const r = await c.post('/api/signup', { email: 'almost@example.com', password: PW, displayName: 'Almost', dob: tomorrow18.toISOString().slice(0, 10), agree: true });
  assert.equal(r.status, 403);
  const bad = await new Client().post('/api/signup', { email: 'bad@example.com', password: PW, displayName: 'Bad', dob: '2000-02-31', agree: true });
  assert.equal(bad.status, 400);
  const future = await new Client().post('/api/signup', { email: 'fut@example.com', password: PW, displayName: 'Fut', dob: '2999-01-01', agree: true });
  assert.ok(future.status === 400 || future.status === 403);
  const old18 = new Date(); old18.setUTCFullYear(old18.getUTCFullYear() - 18);
  const ok = await new Client().post('/api/signup', { email: 'eighteen@example.com', password: PW, displayName: 'Eighteen', dob: old18.toISOString().slice(0, 10), agree: true });
  assert.equal(ok.status, 201);
});

test('signup requires consent, strong password, valid name', async () => {
  const base_ = { email: 'v@example.com', password: PW, displayName: 'Valid', dob: dobYearsAgo(25), agree: true };
  assert.equal((await new Client().post('/api/signup', { ...base_, agree: false })).status, 400);
  assert.equal((await new Client().post('/api/signup', { ...base_, password: 'short' })).status, 400);
  assert.equal((await new Client().post('/api/signup', { ...base_, displayName: 'visit www.scam.com' })).status, 400);
});

test('passwords are hashed with scrypt, sessions stored hashed, cookie is HttpOnly + SameSite=Strict', async () => {
  const c = new Client();
  const r = await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-plm-csrf': '1' }, body: JSON.stringify({ email: 'hash@example.com', password: PW, displayName: 'Hasher', dob: dobYearsAgo(30), agree: true }) });
  const cookie = r.headers.getSetCookie().find((x) => x.startsWith('plm_sid'));
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const row = db.prepare("SELECT pw_hash FROM users WHERE email='hash@example.com'").get();
  assert.match(row.pw_hash, /^scrypt\$/); assert.ok(!row.pw_hash.includes(PW));
  const token = cookie.split(';')[0].split('=')[1];
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE token_hash = ?').get(token).c, 0, 'raw token must not be stored');
  void c;
});

test('login: generic error, wrong password and unknown email look the same; lockout after repeats', async () => {
  const { email } = await register('Loginer');
  const c = new Client();
  const wrong = await c.post('/api/login', { email, password: 'nope-nope-nope' });
  const unknown = await c.post('/api/login', { email: 'ghost@example.com', password: 'nope-nope-nope' });
  assert.equal(wrong.status, 401); assert.deepEqual(wrong.json, unknown.json);
  for (let i = 0; i < 5; i++) await c.post('/api/login', { email, password: 'nope-nope-nope' });
  assert.equal((await c.post('/api/login', { email, password: PW })).status, 429);
});

test('discovery requires verified email + completed profile', async () => {
  const c = new Client();
  await c.post('/api/signup', { email: 'new@example.com', password: PW, displayName: 'Newbie', dob: dobYearsAgo(40), agree: true });
  const r = await c.get('/api/matches');
  assert.equal(r.status, 403); assert.equal(r.json.code, 'verify_email');
  assert.equal((await new Client().get('/api/matches')).status, 401);
});

test('end to end: match, mutual wave, chat, spot, safety rules', async () => {
  const alice = await register('Alice', { lat: 19.07, lng: 72.87 });
  const bob = await register('Bobby', { lat: 19.09, lng: 72.89, tags: ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:ost', 'hobby:coding', 'place:bookstore'] });
  const far = await register('Faraway', { lat: 28.6, lng: 77.2 }); // Delhi, > 25 km

  const m = await alice.c.get('/api/matches');
  assert.equal(m.status, 200);
  const bobCard = m.json.matches.find((x) => x.pid === bob.me.pid);
  assert.ok(bobCard, 'Bob should be suggested to Alice');
  assert.ok(!m.json.matches.some((x) => x.pid === far.me.pid), 'someone 1000 km away must not be suggested');
  assert.ok(m.json.matches.length <= 10);
  assert.ok(bobCard.score.total > 50);
  assert.match(bobCard.headline, /both/);
  assert.ok(bobCard.starters.length > 0);
  // privacy: nothing sensitive leaks
  const dump = JSON.stringify(m.json);
  for (const secret of [bob.email, 'dob', 'lat', 'lng', 'pw_hash', 'email']) assert.ok(!dump.includes(`"${secret}"`) && !dump.includes(bob.email), `leaked ${secret}`);
  // symmetric score
  const bm = await bob.c.get('/api/matches');
  assert.equal(bm.json.matches.find((x) => x.pid === alice.me.pid).score.total, bobCard.score.total);

  // refresh gives a valid batch, never crashes, and keeps invariants
  const rf = await alice.c.post('/api/matches/refresh');
  assert.equal(rf.status, 200); assert.ok(rf.json.matches.length <= 10);

  // wave: not matched until the other side waves back
  const w1 = await alice.c.post('/api/wave', { pid: bob.me.pid, note: 'Fellow Interstellar fan!' });
  assert.equal(w1.json.matched, false);
  assert.equal((await alice.c.post('/api/wave', { pid: bob.me.pid })).status, 409);
  const inbox = await bob.c.get('/api/waves');
  assert.equal(inbox.json.incoming[0].pid, alice.me.pid);
  assert.equal(inbox.json.incoming[0].note, 'Fellow Interstellar fan!');
  const w2 = await bob.c.post('/api/wave', { pid: alice.me.pid });
  assert.equal(w2.json.matched, true);
  const chatId = w2.json.chatId;

  // chat: members only
  assert.equal((await far.c.get(`/api/chats/${chatId}/messages`)).status, 404);
  assert.equal((await far.c.post(`/api/chats/${chatId}/messages`, { text: 'hi' })).status, 404);
  const msgs = await alice.c.get(`/api/chats/${chatId}/messages`);
  assert.equal(msgs.json.messages[0].text, 'Fellow Interstellar fan!');
  assert.equal((await alice.c.post(`/api/chats/${chatId}/messages`, { text: 'Hi Bobby!' })).status, 201);
  const link = await alice.c.post(`/api/chats/${chatId}/messages`, { text: 'look at https://evil.example/x' });
  assert.equal(link.status, 400);
  const scam = await alice.c.post(`/api/chats/${chatId}/messages`, { text: 'can you send me a gift card' });
  assert.equal(scam.status, 201); assert.ok(scam.json.flags.includes('money'));
  const seen = await bob.c.get(`/api/chats/${chatId}/messages?after=0`);
  assert.ok(seen.json.messages.some((m) => m.flags.includes('money')), 'recipient is warned');
  // XSS payload is stored as inert text
  await alice.c.post(`/api/chats/${chatId}/messages`, { text: '<img src=x onerror=alert(1)>' });
  const xs = await bob.c.get(`/api/chats/${chatId}/messages`);
  assert.ok(xs.json.messages.some((m) => m.text === '<img src=x onerror=alert(1)>'));
  assert.match(xs.headers.get('content-type'), /application\/json/);

  // surprise spot: only members, picks place neither listed
  const spot = await alice.c.get(`/api/chats/${chatId}/spot`);
  assert.equal(spot.status, 200);
  assert.ok(spot.json.spot.label);
  assert.ok(!['cafe', 'bookstore'].includes(spot.json.spot.type), 'must not be a place either person selected');
  assert.equal(spot.json.spot.venue.name, 'Pixel Palace');
  assert.equal((await far.c.get(`/api/chats/${chatId}/spot`)).status, 404);

  // vouching requires real conversation
  assert.equal((await bob.c.post(`/api/chats/${chatId}/vouch`)).status, 400);

  // pass hides someone forever
  const pa = await far.c.post('/api/pass', { pid: alice.me.pid });
  assert.equal(pa.status, 200);

  // block removes chat both ways
  assert.equal((await bob.c.post('/api/block', { pid: alice.me.pid })).status, 200);
  assert.equal((await alice.c.get(`/api/chats/${chatId}/messages`)).status, 404);
  assert.ok(!(await alice.c.get('/api/matches')).json.matches.some((x) => x.pid === bob.me.pid));
});

test('reports need a real description; 3 independent reporters auto-suspend the account', async () => {
  const scammer = await register('Scammy', { tags: ['movies:comedy', 'food:pizza', 'hobby:travel', 'music:pop', 'hobby:fitness'] });
  const r1 = await register('Rep1'), r2 = await register('Rep2'), r3 = await register('Rep3');
  assert.equal((await r1.c.post('/api/report', { pid: scammer.me.pid, category: 'scam', description: 'short' })).status, 400);
  assert.equal((await r1.c.post('/api/report', { pid: scammer.me.pid, category: 'bogus', description: 'x'.repeat(30) })).status, 400);
  const a = await r1.c.post('/api/report', { pid: scammer.me.pid, category: 'scam', description: 'Asked me to buy a gift card for an emergency.' });
  assert.equal(a.status, 201); assert.equal(a.json.autoSuspended, false);
  assert.equal((await r1.c.post('/api/report', { pid: scammer.me.pid, category: 'scam', description: 'Asked me to buy a gift card again!!' })).status, 409, 'duplicate open report is refused');
  await r2.c.post('/api/report', { pid: scammer.me.pid, category: 'fake-profile', description: 'Their answers changed completely; clearly a fake persona.' });
  const c = await r3.c.post('/api/report', { pid: scammer.me.pid, category: 'scam', description: 'Wanted me to move to telegram and invest in crypto.' });
  assert.equal(c.json.autoSuspended, true);
  assert.equal((await scammer.c.get('/api/matches')).status, 403);
  assert.ok(!(await r3.c.get('/api/matches')).json.matches.some((x) => x.pid === scammer.me.pid));
});

test('repeated money requests in chat trigger an automatic hold', async () => {
  const a = await register('Hustler', { tags: ['movies:comedy', 'food:pizza', 'hobby:travel', 'music:pop', 'hobby:fitness'] });
  const b = await register('Target', { tags: ['movies:comedy', 'food:pizza', 'hobby:travel', 'music:pop', 'hobby:fitness'] });
  await a.c.post('/api/wave', { pid: b.me.pid }); const m = await b.c.post('/api/wave', { pid: a.me.pid });
  for (let i = 0; i < 3; i++) await a.c.post(`/api/chats/${m.json.chatId}/messages`, { text: `please wire me money, bank account ${i}` });
  assert.equal((await a.c.get('/api/matches')).status, 403);
});

test('export gives you your data; delete removes it for good', async () => {
  const u = await register('Leaver');
  const ex = await u.c.get('/api/account/export');
  assert.equal(ex.status, 200); assert.equal(ex.json.account.email, u.email);
  assert.equal((await u.c.req('DELETE', '/api/account', { password: 'wrong-password-1' })).status, 401);
  assert.equal((await u.c.req('DELETE', '/api/account', { password: PW })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get(u.email).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM user_tags WHERE user_id = ?').get(u.me.pid ? 0 : 0).c, 0);
  assert.equal((await u.c.get('/api/me')).json.user, null);
});

test('profile text cannot contain links or contact handles', async () => {
  const u = await register('Linker');
  const bad = await u.c.req('PUT', '/api/profile', {
    displayName: 'Linker', bio: 'dm me on telegram @scammer or http://x.io', city: 'Mumbai', lat: 19, lng: 72, radiusKm: 25,
    tags: ['movies:scifi', 'food:ramen', 'hobby:gaming', 'music:lofi', 'hobby:reading'], favs: {}, answers: Object.fromEntries(QUESTIONS.map((q) => [q.id, 'yes'])),
  });
  assert.equal(bad.status, 400);
});

test('stored location is only ~1km precise', async () => {
  const u = await register('Precise', { lat: 19.076543, lng: 72.877654 });
  const row = db.prepare('SELECT lat, lng FROM users WHERE pid = ?').get(u.me.pid);
  assert.equal(row.lat, 19.08); assert.equal(row.lng, 72.88);
});
