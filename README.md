# 🫶 PeopleLikeMe

A calm, photo-free place for introverts to find friends who match their **vibe**.
18+ only · verified email · scam-resistant · no cold DMs.

## Run it
```bash
npm install
npm run seed        # optional: 60 clearly-labelled DEMO profiles (dev only)
npm start           # http://127.0.0.1:3000
npm test            # algorithm + API + security tests
```
Needs Node ≥ 22.13 (uses the built-in `node:sqlite`; no native modules). In dev, the email code is printed to the console and shown on the verify screen.

## What it does
| Ask | Where |
|---|---|
| Age gate (18+) *before* an account exists | `POST /api/signup` – DOB check first; under-18 email hashed to a blocklist + browser flag |
| Match on movies/food/places/hobbies + Yes/Maybe/No questions | `server/matching/engine.js` (see [How matching works](public/algorithm.html)) |
| Max 10 people, each with a visible score; refresh for others | `GET /api/matches`, `POST /api/matches/refresh` |
| Near me | Distance must fit **both** people's radius; location stored at ~1 km precision |
| Chat ("coatroom") only if matched | Mutual **wave** → private chat |
| "You matched because you're both “…”" + conversation starters | `explain()` in the engine |
| Random place neither picked but both would like | `server/matching/spot.js` (OpenStreetMap, public venues only) |
| Report scams | 🚩 on every card/chat; 3 independent reports auto-pause the account; `npm run admin -- reports` |

### Extra features added
Wildcard slots · diversity re-ranking · taste learning from waves/passes/refreshes · rarity-weighted interests · fuzzy typed favourites · trust badges + vouching · block · data export & account deletion · Surprise Spot re-roll · safety tips on every meetup suggestion.

## Anti-catfishing / anti-scam design
No photos (stolen-photo catfishing has nothing to steal) · verified email · mutual-wave-only chat · links blocked · money/urgency/off-platform language warns the recipient · 3 money-pressure messages in 24 h auto-suspend · lower wave limits for new accounts · trust badges · reports with ≥20-char description · banned emails stay blocklisted (hash only).

## Security
scrypt password hashes + a guessability check (common words with digits, keyboard/alphabet runs, all-digits) · sign-in lockout per email+IP (a stranger can't lock you out) with a higher per-email ceiling · hashed session tokens, HttpOnly + SameSite=Strict (+`__Host-`/Secure in production) · CSRF header + Origin check · strict CSP (no inline script/style) via helmet · rate limits & login lockout · parameterised SQL only · strict input validation · all user text rendered via `textContent` (no `innerHTML`) · IDs exposed publicly are random, not sequential · no secrets in code. Dependencies: `express`, `helmet`, `express-rate-limit` only (`npm audit`: 0 vulnerabilities).

## Production checklist (honest limitations)
- Set `NODE_ENV=production`, serve over HTTPS, set `PLM_TRUST_PROXY` behind a proxy (needed for per-IP limits to see real addresses), and configure `PLM_MAIL_WEBHOOK` (+`PLM_MAIL_TOKEN`). In production the server refuses to start without a mail relay (override: `PLM_ALLOW_NO_MAIL=1`).
- Known trade-off: sign-up tells you if an email is already registered (needed for a clear message). Rate-limited, but it does let someone check whether an email has an account.
- **Legal**: Terms/Privacy are templates — have a lawyer review for your jurisdictions (GDPR, DPDP, COPPA-style rules…). A self-declared birth date is the standard 18+ gate; stronger age/ID verification needs a third-party provider.
- Email verification cannot prove someone is *who they claim*; add phone/ID verification if your risk profile needs it.
- Rate-limit counters are in-memory and SQLite is single-node: use Redis/Postgres to scale horizontally. `node:sqlite` is still marked experimental by Node.
- Surprise Spot calls public OpenStreetMap services; follow their usage policy or self-host Overpass/Nominatim at scale.
- Needs real members: with a small community the engine will show fewer than 10 people.
