'use strict';
// DEV ONLY: fills a local database with clearly-labelled DEMO profiles so you can see the matching in action.
//   npm run seed -- [count] [lat] [lng]      (defaults: 60 people around Mumbai)
if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed demo data in production.'); process.exit(1); }
const crypto = require('node:crypto');
const { openDb } = require('../server/db');
const { TAGS, FAV_CATEGORIES } = require('../server/data/taxonomy');
const { QUESTIONS } = require('../server/data/questions');
const A = require('../server/auth');
const { normalizeText } = require('../server/matching/engine');

const [count = 60, lat0 = 19.076, lng0 = 72.8777] = process.argv.slice(2).map(Number);
const db = openDb();
const names = ['Aarav', 'Mira', 'Kabir', 'Isha', 'Noor', 'Dev', 'Anika', 'Rohan', 'Tara', 'Zoya', 'Veer', 'Sana', 'Kian', 'Leela', 'Omar', 'Riya', 'Neel', 'Maya', 'Arjun', 'Esha'];
const bios = ['Quiet, curious, and better in small groups.', 'Will happily talk about books for three hours.', 'Introvert with strong opinions on snacks.', 'Looking for a friend to explore cafés with.', 'Gamer by night, gardener by weekend.', 'Slow texter, loyal friend.', 'New in town and trying to meet kind people.'];
const favSamples = { movie: ['Spirited Away', 'Interstellar', 'Your Name', 'The Grand Budapest Hotel', 'Inception'], food: ['Tonkotsu ramen', 'Masala dosa', 'Margherita pizza', 'Dark chocolate'], place: ['Seaside promenade', 'Old library', 'Rooftop cafe'], music: ['Phoebe Bridgers', 'Hans Zimmer', 'Radiohead', 'Prateek Kuhad'], book: ['Stardew Valley', 'The Hobbit', 'Norwegian Wood'] };
const rnd = (n) => crypto.randomInt(0, n);
const pick = (xs, k) => [...xs].sort(() => crypto.randomInt(0, 3) - 1).slice(0, k);
const allTags = Object.keys(TAGS);
const archetypes = [
  { tags: ['movies:scifi', 'movies:anime', 'hobby:gaming', 'music:ost', 'food:ramen', 'books:manga', 'place:arcade'], bias: 1 },
  { tags: ['hobby:reading', 'books:classics', 'music:lofi', 'food:tea', 'hobby:writing', 'place:library', 'place:bookstore'], bias: 1 },
  { tags: ['hobby:hiking', 'hobby:photography', 'hobby:gardening', 'music:folk', 'food:coffee', 'place:trail', 'place:park'], bias: 0.3 },
  { tags: ['movies:comedy', 'food:pizza', 'hobby:boardgames', 'music:pop', 'hobby:travel', 'food:tacos', 'place:restaurant'], bias: 0 },
];
const now = Date.now();
const ins = db.prepare('INSERT INTO users (pid,email,email_hash,pw_hash,display_name,dob,email_verified,onboarded,bio,city,lat,lng,radius_km,is_demo,created_at) VALUES (?,?,?,?,?,?,1,1,?,?,?,?,?,1,?)');
let made = 0;
for (let i = 0; i < count; i++) {
  const arch = archetypes[rnd(archetypes.length)];
  const email = `demo${crypto.randomBytes(5).toString('hex')}@demo.invalid`;
  const tags = [...new Set([...pick(arch.tags, 4 + rnd(3)), ...pick(allTags, 3 + rnd(5))])];
  const info = ins.run(A.newPid(), email, A.sha256(email), 'scrypt$0$0$0$x$x', `${names[rnd(names.length)]} (demo)`, `${1988 + rnd(15)}-0${1 + rnd(9)}-1${rnd(9)}`, bios[rnd(bios.length)], 'Demo City',
    Math.round((lat0 + (crypto.randomInt(-400, 400) / 4000)) * 100) / 100, Math.round((lng0 + (crypto.randomInt(-400, 400) / 4000)) * 100) / 100, [10, 25, 50][rnd(3)], now - rnd(60) * 86_400_000);
  const id = info.lastInsertRowid;
  for (const t of tags) db.prepare('INSERT INTO user_tags VALUES (?,?)').run(id, t);
  for (const q of QUESTIONS) {
    const lean = (q.dim === 'energy' || q.dim === 'depth' || q.dim === 'pace') ? arch.bias : 0.5;
    const r = crypto.randomInt(0, 100) / 100;
    const v = r < lean * 0.7 + 0.1 ? 1 : r < 0.85 ? (crypto.randomInt(0, 3) === 0 ? 0.5 : 0) : 0.5;
    db.prepare('INSERT INTO user_answers VALUES (?,?,?)').run(id, q.id, v);
  }
  for (const c of FAV_CATEGORIES) if (crypto.randomInt(0, 2)) { const t = favSamples[c.id][rnd(favSamples[c.id].length)]; db.prepare('INSERT INTO user_favs VALUES (?,?,?,?)').run(id, c.id, t, normalizeText(t)); }
  made++;
}
console.log(`Seeded ${made} DEMO profiles near ${lat0}, ${lng0}. They're flagged as demo in the UI and cannot log in.`);
