---
name: verify
description: Run and drive PeopleLikeMe (Node/Express + SQLite + vanilla-JS SPA) to see a change working — start the server, drive it with curl and headless Chromium, probe security behaviour.
---

# Verifying PeopleLikeMe

## Launch (no build step)
```bash
export PLM_DB=$SCRATCH/v.sqlite            # throw-away DB, never the default data/plm.sqlite
node --no-warnings scripts/seed.js 30      # optional DEMO profiles around Mumbai (19.076, 72.8777)
PORT=3222 nohup node --no-warnings server/index.js > $SCRATCH/v.log 2>&1 & echo $! > $SCRATCH/v.pid
```
- Kill by PID file. `pkill -f` / `pgrep -f` match your own shell command line and abort it.
- Dev mode (no `NODE_ENV`): signup and resend responses include `devCode`, so you can verify email without a mailer.
- Do NOT set `PLM_TEST=1` when verifying: it turns the rate limiters off. Leave it unset to see the real 429s and lockouts.
- Production mode: `NODE_ENV=production PLM_MAIL_WEBHOOK=http://127.0.0.1:<port>` + a tiny HTTP sink to capture the emailed code. Cookie becomes `__Host-plm_sid; Secure`, HSTS appears.

## Drive it
- API: every non-GET needs `-H x-plm-csrf:1 -H content-type:application/json`. Public user ids are `pid` strings, never integers.
- GUI: playwright-core + the preinstalled Chromium (`/opt/pw-browsers/chromium-*/chrome-linux/chrome`, launch with `--no-sandbox`). Grant geolocation (19.076, 72.8777) to use "Use my location" in setup.
- Fast two-user setup: sign up + `POST /api/verify` + `PUT /api/profile` (needs 5+ tags, all 16 `q_*` answers as yes/maybe/no, city, lat, lng, radiusKm) through fetch, then inject the `plm_sid` cookie into a browser context.
- Flows worth driving: sign-up with under-18 DOB (403, no row, email blocklisted); onboarding; Discover deck (max 4 cards visible at >=1180px, arrows, Details, refresh); wave -> mutual wave -> chat; scam phrase warning; link blocked; Surprise Spot.
- Surprise Spot venues need OpenStreetMap, which sandboxes often block; the UI then shows the "kind of place" fallback. That is expected.

## Security probes that have been worth running
Stored-XSS payload in bio/favourite/wave note/chat (must render as text, 0 alerts); IDOR on `/api/chats/:id/*` as a third user (404); CSRF header/Origin; login lockout (5 fails -> 429, also blocks the real owner); IP auth limiter (20/15 min shared by signup/login/verify); verify-code brute force (5 tries).

## Gotchas
- Screenshots: the deck animates in (~1.5 s); wait before capturing.
- Playwright's own video recorder may lack ffmpeg here; take frames and pipe them (`image2pipe`, `pipe:0`) into the bundled ffmpeg instead.
