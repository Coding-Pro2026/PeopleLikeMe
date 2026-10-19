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

const COMMON = new Set(['password', 'password1', 'password123', '1234567890', 'qwertyuiop', 'letmein123', 'iloveyou123', 'welcome123', 'abc1234567', 'passw0rd123']);
function passwordProblem(pw, email = '') {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 128) return 'Password is too long (max 128).';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common.';
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length > 3) return 'Don’t put your email name in your password.';
  if (new Set(pw).size < 5) return 'Use a more varied password.';
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
