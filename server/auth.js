'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const dk = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(dk, expected);
}
// Used to equalise timing when the account doesn't exist (no user enumeration by response time).
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

// Bases that are guessable even with digits/symbols tacked on ("password1234", "Welcome2024!").
const COMMON_BASES = new Set(['password', 'passw0rd', 'pass', 'welcome', 'letmein', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'iloveyou', 'admin', 'administrator', 'login', 'monkey', 'dragon', 'football', 'baseball', 'basketball', 'master', 'sunshine', 'princess', 'shadow', 'superman', 'batman', 'trustno', 'freedom', 'whatever', 'starwars', 'hello', 'secret', 'changeme', 'abc', 'abcdef', 'abcdefgh', 'peoplelikeme', 'friends', 'friend', 'google', 'facebook', 'default', 'summer', 'winter', 'spring', 'autumn', 'killer', 'jordan', 'michael', 'charlie', 'donald', 'ranger', 'hunter', 'soccer', 'hockey', 'cookie', 'flower', 'internet', 'computer', 'mustang', 'harley', 'matrix', 'access', 'maggie', 'buster', 'thomas', 'tigger', 'pepper', 'ginger', 'welcome1', 'test', 'testing', 'guest', 'user', 'india', 'mumbai', 'delhi']);
const ROWS = ['qwertyuiopasdfghjklzxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz'];
function hasRun(pw, n) { // n+ consecutive keys on a keyboard row / alphabet / digits, forwards or backwards
  const x = pw.toLowerCase();
  for (const row of ROWS) for (const r of [row, [...row].reverse().join('')]) for (let i = 0; i + n <= x.length; i++) if (r.includes(x.slice(i, i + n))) return true;
  return false;
}
function passwordProblem(pw, email = '') {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 128) return 'Password is too long (max 128).';
  const letters = pw.toLowerCase().replace(/[^a-z]/g, '');
  const base = pw.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/[0-9]+$/, '').replace(/^[0-9]+/, '');
  if (COMMON_BASES.has(base) || (letters.length >= 4 && [...COMMON_BASES].some((w) => w.length >= 6 && base === w))) return 'That password is too easy to guess. Try a few random words instead.';
  for (const w of COMMON_BASES) if (w.length >= 6 && base.startsWith(w) && base.length <= w.length + 4) return 'That password is too easy to guess. Try a few random words instead.';
  if (/^[0-9\W_]+$/.test(pw)) return 'Add some letters — numbers alone are easy to guess.';
  if (hasRun(pw.replace(/[^a-z0-9]/gi, ''), 6)) return 'Avoid keyboard or alphabet sequences like “qwerty” or “12345678”.';
  if (new Set(pw.toLowerCase()).size < 6) return 'Use a more varied password.';
  const local = email.split('@')[0].toLowerCase();
  if (local.length > 3 && pw.toLowerCase().includes(local)) return 'Don’t put your email name in your password.';
  return null;
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const newPid = () => crypto.randomBytes(9).toString('base64url');
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const safeEqual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Whole years between dob (YYYY-MM-DD) and `now`. Returns null if not a real date. */
function ageFromDob(dob, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || '');
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age--;
  return age;
}
const ageBand = (age) => (age < 25 ? '18–24' : age < 30 ? '25–29' : age < 35 ? '30–34' : age < 45 ? '35–44' : age < 55 ? '45–54' : '55+');

module.exports = { sha256, hashPassword, verifyPassword, DUMMY_HASH, passwordProblem, newToken, newPid, newCode, safeEqual, ageFromDob, ageBand };
