'use strict';
/* PeopleLikeMe front-end. No framework, no innerHTML: every piece of user-supplied text
   goes through textContent, so stored XSS is structurally impossible. */

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const $ = (s) => document.querySelector(s);
const mount = (...nodes) => { const m = $('#main'); m.replaceChildren(...nodes); window.scrollTo(0, 0); };

function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('#toasts').append(t); setTimeout(() => t.remove(), 4200);
}
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { 'x-plm-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong.'); e.code = data.code; e.status = res.status; throw e; }
  return data;
}
const S = { user: null, meta: null, waves: 0, timers: [] };
const clearTimers = () => { S.timers.forEach(clearInterval); S.timers = []; };
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const GROUP_LABEL = (id) => S.meta.groups.find((g) => g.id === id);

// ---------- dialogs ----------
function dialog(build) {
  const d = $('#dlg'); const close = () => d.close();
  d.replaceChildren(build(close)); d.showModal();
  d.addEventListener('close', () => d.replaceChildren(), { once: true });
}

// ---------- shared UI pieces ----------
function avatar(card) {
  const top = card.tags?.[0]?.emoji || '🙂';
  return h('div', { class: 'avatar', 'aria-hidden': 'true', style: { '--h': hue(card.pid || card.name) } }, top);
}
function ring(total) {
  const c = total >= 75 ? 'var(--good)' : total >= 50 ? 'var(--brand)' : 'var(--warn)';
  return h('div', { class: 'ring', style: { '--p': total, '--ringc': c }, role: 'img', 'aria-label': `${total}% vibe match` }, h('span', {}, total + '%'));
}
function bar(label, v) { return h('div', { class: 'bar' }, h('span', {}, label), h('i', {}, h('b', { style: { '--v': v } })), h('span', {}, v + '%')); }
function trustBadge(t) {
  const m = { new: ['🌱', 'New member'], verified: ['✅', 'Verified'], trusted: ['🛡️', `Trusted · ${t.vouches} vouches`], 'under-review': ['⚠️', 'Under review'] }[t.level] || ['', ''];
  return h('span', { class: 'badge ' + t.level, title: 'Email-verified accounts only. Trust grows with time, good conduct and vouches from people they have chatted with.' }, m[0], ' ', m[1]);
}
const catLabel = (id) => S.meta.favCategories.find((c) => c.id === id)?.label || id;

function openReport(card, onDone) {
  dialog((close) => {
    const cat = h('select', { id: 'rc' }, [['scam', 'Scam or asking for money'], ['fake-profile', 'Fake profile / catfishing'], ['harassment', 'Harassment or pressure'], ['underage', 'Seems under 18'], ['inappropriate', 'Inappropriate content'], ['other', 'Something else']].map(([v, l]) => h('option', { value: v }, l)));
    const desc = h('textarea', { id: 'rd', maxlength: 1000, placeholder: 'What happened? Include what they said or did. (min 20 characters)' });
    const err = h('p', { class: 'err', role: 'alert' });
    return h('form', { method: 'dialog', class: 'stack', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { const r = await api('POST', '/report', { pid: card.pid, category: cat.value, description: desc.value }); toast(r.message); close(); onDone?.(); } catch (x) { err.textContent = x.message; }
    } },
      h('h2', {}, `Report ${card.name}`),
      h('p', { class: 'muted small' }, 'We’ll block them for you straight away, and our safety team reviews every report. Reports with 3 independent reporters pause the account automatically.'),
      h('div', {}, h('label', { for: 'rc' }, 'What’s going on?'), cat),
      h('div', {}, h('label', { for: 'rd' }, 'Describe it'), desc),
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'submit' }, 'Send report'), h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel')));
  });
}
function openBlock(card, onDone) {
  dialog((close) => h('div', { class: 'stack' },
    h('h2', {}, `Block ${card.name}?`), h('p', {}, 'You won’t see each other again and any chat is removed. They aren’t told.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn danger', onclick: async () => { try { await api('POST', '/block', { pid: card.pid }); close(); toast('Blocked.'); onDone?.(); } catch (x) { toast(x.message, true); } } }, 'Block'),
      h('button', { class: 'btn ghost', onclick: close }, 'Cancel'))));
}
function openWave(card, preset, onDone) {
  dialog((close) => {
    const note = h('textarea', { maxlength: 140, id: 'wn', placeholder: 'Optional hello (no links). Tap a starter below to use it.' }, preset || '');
    const err = h('p', { class: 'err', role: 'alert' });
    return h('form', { method: 'dialog', class: 'stack', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try {
        const r = await api('POST', '/wave', { pid: card.pid, note: note.value });
        close();
        if (r.matched) { toast('🎉 It’s a match! Your chat is open.'); location.hash = `#/chat/${r.chatId}`; } else { toast(`👋 Wave sent. If ${card.name} waves back, you’ll be matched.`); onDone?.(); }
      } catch (x) { err.textContent = x.message; }
    } },
      h('h2', {}, `Say hi to ${card.name}`),
      h('p', { class: 'muted' }, 'Nothing happens until they wave back — no pressure, no awkward rejections.'),
      h('div', {}, h('label', { for: 'wn' }, 'A little hello'), note),
      h('div', { class: 'chips' }, (card.starters || []).slice(0, 3).map((s) => h('button', { type: 'button', class: 'chip starter', onclick: () => { note.value = s.slice(0, 140); note.focus(); } }, s))),
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Send wave 👋'), h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel')));
  });
}

function openDetails(card, { remove, mode }) {
  dialog((close) => {
    const shared = new Set(card.sharedTags || []);
    const tags = [...card.tags].sort((a, b) => (shared.has(b.id) - shared.has(a.id)));
    return h('div', { class: 'stack detail' },
      h('header', { class: 'row' }, avatar(card), h('div', { class: 'who' }, h('strong', {}, card.name), h('span', { class: 'muted small' }, [card.ageBand, card.city, card.distance].filter(Boolean).join(' · ')), h('div', {}, trustBadge(card.trust))), ring(card.score.total)),
      h('div', { class: 'why' }, '💡 ', card.headline),
      h('div', { class: 'bars' }, bar('Personality', card.score.personality), bar('Interests', card.score.interests)),
      card.bio ? h('p', {}, card.bio) : null,
      h('div', {}, h('h3', {}, 'Interests'), h('div', { class: 'chips' }, tags.map((t) => h('span', { class: 'chip' + (shared.has(t.id) ? ' shared' : '') }, t.emoji, ' ', t.label))), h('p', { class: 'hint' }, 'Outlined = you both like it.')),
      card.favs?.length ? h('div', {}, h('h3', {}, 'Favourites'), h('p', { class: 'small' }, card.favs.map((f) => `${({ movie: '🎬', food: '🍴', place: '📍', music: '🎵', book: '📖' })[f.cat] || '⭐'} ${f.text}`).join('   '))) : null,
      h('div', {}, h('h3', {}, 'Conversation starters'), h('div', { class: 'chips' }, card.starters.map((st) => h('button', { class: 'chip starter', onclick: () => { close(); openWave(card, st, remove); } }, st)))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { close(); openWave(card, '', remove); } }, mode === 'inbox' ? 'Wave back 👋' : 'Say hi 👋'),
        h('button', { class: 'btn ghost', onclick: () => { close(); openReport(card, remove); } }, '🚩 Report'),
        h('button', { class: 'btn ghost', onclick: () => { close(); openBlock(card, remove); } }, '🚫 Block'),
        h('button', { class: 'btn soft', onclick: close }, 'Close')));
  });
}

function personCard(card, { onChange, mode = 'discover' }) {
  const shared = new Set(card.sharedTags || []);
  const sharedTags = card.tags.filter((t) => shared.has(t.id));
  const shown = sharedTags.slice(0, 4);
  const more = card.tags.length - shown.length;
  const remove = () => { el.remove(); onChange?.(); refreshBadge(); };
  const el = h('article', { class: 'card' + (card.slot === 'wildcard' ? ' wild' : ''), style: { '--h': hue(card.pid || card.name) }, 'aria-label': card.name },
    h('div', { class: 'banner' }, card.slot === 'wildcard' ? h('span', { class: 'ribbon' }, '✨ Wildcard') : h('span', { class: 'ribbon' }, card.score.total >= 75 ? '💜 Great fit' : card.score.total >= 55 ? 'Good fit' : 'Worth a hello'), ring(card.score.total)),
    h('div', { class: 'cardbody' },
      h('div', { class: 'who' }, h('strong', {}, card.name, card.demo ? h('span', { class: 'badge demo' }, 'demo') : null), h('span', { class: 'muted small' }, [card.ageBand, card.distance].filter(Boolean).join(' · ')), trustBadge(card.trust)),
      h('p', { class: 'why' }, card.headline),
      shown.length ? h('div', { class: 'chips' }, shown.map((t) => h('span', { class: 'chip shared' }, t.emoji, ' ', t.label)), more > 0 ? h('span', { class: 'chip more' }, `+${more}`) : null) : null,
      card.note ? h('div', { class: 'callout small' }, '“', card.note, '”') : null),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => openWave(card, '', remove) }, mode === 'inbox' ? 'Wave back 👋' : 'Say hi 👋'),
      h('button', { class: 'btn soft', onclick: () => openDetails(card, { remove, mode }) }, 'Details'),
      h('button', { class: 'btn ghost icon', 'aria-label': 'Not for me', title: 'Not for me', onclick: async () => { try { await api('POST', '/pass', { pid: card.pid }); remove(); } catch (x) { toast(x.message, true); } } }, '✕')));
  el.prepend(h('div', { class: 'avatar big', 'aria-hidden': 'true', style: { '--h': hue(card.pid || card.name) } }, card.tags?.[0]?.emoji || '🙂'));
  return el;
}

// ---------- theme ----------
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('plm-theme', next); } catch { /* private mode */ }
  renderTop();
}

// ---------- header ----------
function renderTop() {
  const u = S.user;
  const link = (href, label, extra) => h('a', { href, 'aria-current': location.hash.startsWith(href) ? 'page' : null }, label, extra);
  $('#top').replaceChildren(
    h('a', { class: 'brand', href: u ? '#/discover' : '#/' }, '🫶 People', h('b', {}, 'Like'), 'Me'),
    h('button', { class: 'themebtn', 'aria-label': 'Toggle light / dark theme', title: 'Toggle theme', onclick: toggleTheme }, document.documentElement.dataset.theme === 'light' ? '🌙' : '☀️'),
    h('nav', { 'aria-label': 'Main' }, u && u.onboarded && u.emailVerified ? [
      link('#/discover', 'Discover'), link('#/waves', 'Waves', S.waves ? h('span', { class: 'dot' }, S.waves) : null), link('#/chat', 'Coatroom'), link('#/safety', 'Safety'), link('#/settings', 'Me'),
    ] : u ? [link('#/safety', 'Safety'), h('a', { href: '#/logout' }, 'Sign out')] : [link('#/safety', 'Safety'), link('#/login', 'Sign in'), h('a', { class: 'btn small', href: '#/signup' }, 'Join free')]));
}
async function refreshBadge() {
  if (!S.user?.onboarded || !S.user?.emailVerified) return;
  try { S.waves = (await api('GET', '/waves')).incoming.length; renderTop(); } catch { /* ignore */ }
}

// ---------- views ----------
const views = {};

views.landing = () => mount(
  h('section', { class: 'hero' },
    h('h1', {}, 'Finding friends shouldn’t feel like ', h('span', { class: 'grad' }, 'a performance.')),
    h('p', { class: 'lead' }, 'PeopleLikeMe matches you with people who share your vibe — your pace, your favourite films, your comfort foods — and nudges you toward a low-pressure first hello. No photos. No follower counts. No small-talk pressure.'),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/signup' }, 'Find my people →'), h('a', { class: 'btn ghost', href: '/algorithm.html' }, 'How the matching works'))),
  h('div', { class: 'grid3' },
    h('div', { class: 'panel' }, h('div', { class: 'big' }, '🧠'), h('h3', {}, 'A matching engine that gets you'), h('p', { class: 'muted' }, 'Yes / Maybe / No questions plus the things you love — weighted so rare shared passions count more. You see your exact score with everyone, and why.')),
    h('div', { class: 'panel' }, h('div', { class: 'big' }, '👋'), h('h3', {}, 'Wave. Only mutual waves chat.'), h('p', { class: 'muted' }, 'No cold DMs, no ghosting drama. When you both wave, a private chat opens with conversation starters built from what you share.')),
    h('div', { class: 'panel' }, h('div', { class: 'big' }, '🎲'), h('h3', {}, 'Surprise Spot'), h('p', { class: 'muted' }, 'Matched? We pick a random public place near you both — one neither of you listed, but both would likely love.'))),
  h('div', { class: 'panel' }, h('h2', {}, 'Built to be safe'),
    h('div', { class: 'chips' }, ['18+ only, checked before sign-up', 'Verified email required', 'No photos = no stolen-photo catfishing', 'Links blocked in chat', 'Scam-language warnings', 'One-tap report & block', 'Delete your data anytime'].map((t) => h('span', { class: 'chip' }, '✓ ' + t)))));

views.signup = () => {
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { class: 'panel narrow stack', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const f = Object.fromEntries(new FormData(form));
    try {
      const r = await api('POST', '/signup', { email: f.email, password: f.password, displayName: f.displayName, dob: f.dob, agree: f.agree === 'on' });
      S.devCode = r.devCode; await boot(); location.hash = '#/verify';
    } catch (x) { err.textContent = x.message; if (x.code === 'underage') form.replaceChildren(h('h2', {}, 'Sorry — 18+ only'), h('p', {}, 'PeopleLikeMe is for adults. Come back when you’re 18 — we’ll be here. 💜')); }
  } },
    h('h2', {}, 'Create your account'),
    h('p', { class: 'muted small' }, 'We ask your birthday first — PeopleLikeMe is strictly 18+. We only show an age range to others, never your birthday.'),
    h('div', { class: 'field' }, h('label', { for: 'dob' }, 'Date of birth'), h('input', { id: 'dob', name: 'dob', type: 'date', required: true, autocomplete: 'bday', max: new Date().toISOString().slice(0, 10) })),
    h('div', { class: 'field' }, h('label', { for: 'dn' }, 'Display name'), h('input', { id: 'dn', name: 'displayName', required: true, maxlength: 24, autocomplete: 'nickname' }), h('p', { class: 'hint' }, 'No real name needed — pick anything friendly.')),
    h('div', { class: 'field' }, h('label', { for: 'em' }, 'Email'), h('input', { id: 'em', name: 'email', type: 'email', required: true, autocomplete: 'email' }), h('p', { class: 'hint' }, 'Used only to verify you’re real and for sign-in. Never shown.')),
    h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password'), h('input', { id: 'pw', name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), h('p', { class: 'hint' }, 'At least 10 characters. A few random words works great.')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'agree' }), h('span', {}, 'I am 18 or older and I accept the ', h('a', { href: '/terms.html', target: '_blank', rel: 'noopener' }, 'Terms'), ' and ', h('a', { href: '/privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy Policy'), '.')),
    err, h('button', { class: 'btn', type: 'submit' }, 'Continue'),
    h('p', { class: 'small muted center' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in')));
  mount(form);
};

views.login = () => {
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { class: 'panel narrow stack', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const f = Object.fromEntries(new FormData(form));
    try { await api('POST', '/login', { email: f.email, password: f.password }); await boot(); location.hash = '#/discover'; } catch (x) { err.textContent = x.message; }
  } },
    h('h2', {}, 'Welcome back'),
    h('div', { class: 'field' }, h('label', { for: 'le' }, 'Email'), h('input', { id: 'le', name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    h('div', { class: 'field' }, h('label', { for: 'lp' }, 'Password'), h('input', { id: 'lp', name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    err, h('button', { class: 'btn', type: 'submit' }, 'Sign in'),
    h('p', { class: 'small muted center' }, 'New here? ', h('a', { href: '#/signup' }, 'Create an account')));
  mount(form);
};

views.verify = () => {
  const err = h('p', { class: 'err', role: 'alert' });
  const code = h('input', { id: 'vc', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 6, autocomplete: 'one-time-code', required: true, placeholder: '6-digit code' });
  mount(h('form', { class: 'panel narrow stack', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await api('POST', '/verify', { code: code.value.trim() }); await boot(); toast('Email verified ✅'); location.hash = '#/setup'; } catch (x) { err.textContent = x.message; }
  } },
    h('h2', {}, 'Check your email'),
    h('p', { class: 'muted' }, `We sent a 6-digit code to ${S.user.email}. Verified emails keep fake accounts out.`),
    S.devCode ? h('p', { class: 'callout warn small' }, `Developer mode: no email is sent. Your code is ${S.devCode}.`) : null,
    h('div', { class: 'field' }, h('label', { for: 'vc' }, 'Code'), code), err,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Verify'),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { try { const r = await api('POST', '/verify/resend'); S.devCode = r.devCode; toast('New code sent.'); views.verify(); } catch (x) { toast(x.message, true); } } }, 'Send a new code'))));
};

// ----- onboarding / profile editor -----
views.setup = () => {
  const u = S.user, M = S.meta;
  const d = S.draft ||= {
    displayName: u.name, bio: u.bio || '', city: u.city || '', lat: null, lng: null, radiusKm: u.radiusKm || 25,
    tags: new Set(u.tags), favs: Object.fromEntries(M.favCategories.map((c) => [c.id, u.favs.filter((f) => f.cat === c.id).map((f) => f.text)])),
    answers: { ...Object.fromEntries(Object.entries(u.answers || {}).map(([k, v]) => [k, v === 1 ? 'yes' : v === 0 ? 'no' : 'maybe'])) }, step: 0, hadLocation: u.hasLocation,
  };
  const steps = ['About you', 'Interests', 'Favourites', 'Your vibe', 'Finish'];
  const err = h('p', { class: 'err', role: 'alert' });
  const go = (n) => { d.step = n; views.setup(); };
  const nav = (next, label = 'Next →') => h('div', { class: 'row' }, d.step > 0 ? h('button', { class: 'btn ghost', type: 'button', onclick: () => go(d.step - 1) }, '← Back') : null, h('button', { class: 'btn', type: 'button', onclick: next }, label));
  let body;
  if (d.step === 0) {
    const name = h('input', { id: 'sn', value: d.displayName, maxlength: 24 });
    const bio = h('textarea', { id: 'sb', maxlength: 280, placeholder: 'e.g. Quiet, curious, happiest with a book and a friend who texts back eventually.' }, d.bio);
    const city = h('input', { id: 'sc', value: d.city, maxlength: 60, placeholder: 'Search your city or area…', autocomplete: 'off' });
    const results = h('div', { class: 'chips' });
    const locState = h('p', { class: 'hint' }, d.lat != null ? '📍 Location set (rounded to about 1 km for privacy).' : d.hadLocation ? '📍 Using your saved location. Search again to change it.' : 'We only store an approximate location (~1 km).');
    const setLoc = (lat, lng, label) => { d.lat = lat; d.lng = lng; if (label) { d.city = label; city.value = label; } locState.textContent = '📍 Location set (rounded to about 1 km for privacy).'; results.replaceChildren(); };
    const search = async () => {
      try { const r = await api('GET', '/geocode?q=' + encodeURIComponent(city.value)); results.replaceChildren(...r.results.map((x) => h('button', { type: 'button', class: 'chip', onclick: () => setLoc(x.lat, x.lng, x.label.split(',').slice(0, 2).join(',').trim()) }, '📍 ' + x.label))); if (!r.results.length) toast('No places found.'); } catch (x) { toast(x.message, true); }
    };
    const geo = () => navigator.geolocation?.getCurrentPosition(async (p) => {
      const lat = p.coords.latitude, lng = p.coords.longitude;
      let label = ''; try { label = (await api('GET', `/geocode/reverse?lat=${lat}&lng=${lng}`)).city; } catch { /* ignore */ }
      setLoc(lat, lng, label || city.value || 'My area');
    }, () => toast('Couldn’t get your location — search for your city instead.', true), { maximumAge: 600000, timeout: 10000 });
    city.addEventListener('input', () => { d.city = city.value; });
    body = [h('h2', {}, 'First, a little about you'),
      h('div', { class: 'field' }, h('label', { for: 'sn' }, 'Display name'), name),
      h('div', { class: 'field' }, h('label', { for: 'sb' }, 'Short bio (optional)'), bio, h('p', { class: 'hint' }, 'No links or contact details here — keep that for chat, once you trust someone.')),
      h('div', { class: 'field' }, h('label', { for: 'sc' }, 'Where are you?'), h('div', { class: 'row' }, city, h('button', { class: 'btn soft small', type: 'button', onclick: search }, 'Search'), h('button', { class: 'btn soft small', type: 'button', onclick: geo }, '📍 Use my location')), results, locState),
      err, nav(() => {
        d.displayName = name.value; d.bio = bio.value; d.city = city.value;
        if (!d.displayName.trim() || !d.city.trim()) { err.textContent = 'Please add a display name and your area.'; return; }
        if (d.lat == null && !d.hadLocation) { err.textContent = 'Pick your location with Search or “Use my location”.'; return; }
        go(1);
      })];
  } else if (d.step === 1) {
    const count = h('span', { class: 'muted' });
    const upd = () => { count.textContent = `${d.tags.size} selected (pick ${M.minTags}–${M.maxTags})`; };
    body = [h('h2', {}, 'What are you into?'), h('p', { class: 'muted' }, 'Tap everything that feels like you. Rarer shared interests count for more in your match score.'), count,
      ...M.groups.map((g) => h('section', { class: 'stack' }, h('h3', {}, g.emoji, ' ', g.label), g.id === 'places' ? h('p', { class: 'hint' }, 'Tip: our Surprise Spot picks places you did NOT choose here — so you’ll discover something new together.') : null,
        h('div', { class: 'chips' }, g.tags.map((t) => h('button', { type: 'button', class: 'chip', 'aria-pressed': d.tags.has(t.id), onclick: (e) => { if (d.tags.has(t.id)) d.tags.delete(t.id); else if (d.tags.size < M.maxTags) d.tags.add(t.id); e.currentTarget.setAttribute('aria-pressed', d.tags.has(t.id)); upd(); } }, t.emoji, ' ', t.label))))),
      err, nav(() => { if (d.tags.size < M.minTags) { err.textContent = `Pick at least ${M.minTags} interests.`; return; } go(2); })];
    upd();
  } else if (d.step === 2) {
    const inputs = {};
    body = [h('h2', {}, 'Your all-time favourites'), h('p', { class: 'muted' }, 'Optional, but a shared favourite is a powerful signal. Up to 3 per box, separate with commas.'),
      ...M.favCategories.map((c) => { inputs[c.id] = h('input', { id: 'f' + c.id, value: (d.favs[c.id] || []).join(', '), maxlength: 130, placeholder: c.placeholder }); return h('div', { class: 'field' }, h('label', { for: 'f' + c.id }, c.label), inputs[c.id]); }),
      nav(() => { for (const c of M.favCategories) d.favs[c.id] = inputs[c.id].value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3); go(3); })];
  } else if (d.step === 3) {
    const left = h('strong', {});
    const upd = () => { left.textContent = `${Object.keys(d.answers).length} / ${M.questions.length} answered`; };
    body = [h('h2', {}, 'Your vibe'), h('p', { class: 'muted' }, 'Quick and honest — there are no right answers. “Maybe” is fine, it just tells us less.'), left,
      ...M.questions.map((q) => {
        const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': q.text });
        for (const [v, l] of [['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']]) seg.append(h('button', { type: 'button', role: 'radio', 'aria-checked': d.answers[q.id] === v, onclick: () => { d.answers[q.id] = v; [...seg.children].forEach((b) => b.setAttribute('aria-checked', b.textContent.toLowerCase() === v)); upd(); } }, l));
        return h('div', { class: 'q' }, h('p', {}, q.text), seg);
      }),
      err, nav(() => { if (Object.keys(d.answers).length < M.questions.length) { err.textContent = 'Please answer every question.'; return; } go(4); })];
    upd();
  } else {
    const sel = h('select', { id: 'rad' }, M.radii.map((r) => h('option', { value: r, selected: r === d.radiusKm }, `${r} km`)));
    body = [h('h2', {}, 'How far are you willing to travel?'), h('p', { class: 'muted' }, 'We only suggest people who are within BOTH your distance and theirs.'),
      h('div', { class: 'field' }, h('label', { for: 'rad' }, 'Distance'), sel),
      h('div', { class: 'callout' }, h('strong', {}, 'Before you finish: '), 'we show others your display name, an age range, your area, bio, interests and favourites. Never your email, birthday, or exact location.'),
      err, nav(async () => {
        try {
          const r = await api('PUT', '/profile', { displayName: d.displayName, bio: d.bio, city: d.city, lat: d.lat ?? 0, lng: d.lng ?? 0, radiusKm: Number(sel.value), tags: [...d.tags], favs: d.favs, answers: d.answers, keepLocation: d.lat == null });
          S.user = r.user; S.draft = null; toast('Profile saved 🎉'); location.hash = '#/discover';
        } catch (x) { err.textContent = x.message; }
      }, 'Save & find my people')];
  }
  mount(h('div', { class: 'mid' }, h('ol', { class: 'steps', 'aria-label': `Step ${d.step + 1} of ${steps.length}: ${steps[d.step]}` }, steps.map((s, i) => h('li', { class: i < d.step ? 'done' : i === d.step ? 'now' : '' }))), h('div', { class: 'stack' }, body)));
};

views.discover = async () => {
  mount(h('p', { class: 'muted center' }, 'Finding your people…'));
  let data;
  try { data = await api('GET', '/matches'); } catch (x) { return mount(h('p', { class: 'err' }, x.message)); }
  const grid = h('div', { class: 'cards' });
  const head = h('div', { class: 'row' }, h('div', { style: { 'margin-right': 'auto' } }, h('h2', { style: { margin: 0 } }, 'Your people nearby'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Same score for both of you · nothing happens until someone waves')));
  const draw = (matches, recycled) => {
    grid.replaceChildren(...matches.map((m) => personCard(m, { onChange: check })));
    status.textContent = recycled ? 'You’ve seen everyone nearby — here’s a fresh round with new ordering.' : `${matches.length} suggestion${matches.length === 1 ? '' : 's'} · ${data.communitySize} members on PeopleLikeMe`;
    check();
  };
  const check = () => { empty.hidden = grid.children.length > 0; };
  const refresh = h('button', { class: 'btn soft', onclick: async () => {
    refresh.disabled = true;
    try { const r = await api('POST', '/matches/refresh'); draw(r.matches, r.recycled); window.scrollTo(0, 0); } catch (x) { toast(x.message, true); } finally { refresh.disabled = false; }
  } }, '🔄 Not my type — refresh');
  head.append(refresh);
  const status = h('p', { class: 'muted small' });
  const empty = h('div', { class: 'empty', hidden: true }, h('div', { class: 'big' }, '🌱'), h('h3', {}, 'No one new right now'), h('p', {}, 'You may be one of the first in your area, or you’ve seen everyone nearby. Try refresh, widen your distance in Me → Edit profile, or invite a friend — every new member makes matching better.'));
  mount(head, status, grid, empty);
  draw(data.matches);
};

views.waves = async () => {
  mount(h('p', { class: 'muted' }, 'Loading…'));
  let d; try { d = await api('GET', '/waves'); } catch (x) { return mount(h('p', { class: 'err' }, x.message)); }
  S.waves = d.incoming.length; renderTop();
  const grid = h('div', { class: 'cards' }, d.incoming.map((c) => personCard(c, { mode: 'inbox', onChange: () => { if (!grid.children.length) grid.replaceWith(emptyEl()); } })));
  const emptyEl = () => h('div', { class: 'empty' }, h('div', { class: 'big' }, '👋'), h('p', {}, 'No waves waiting. When someone waves at you, they appear here — and you decide.'));
  mount(h('h2', {}, 'People who waved at you'), h('p', { class: 'muted' }, `You also have ${d.outgoingPending} wave${d.outgoingPending === 1 ? '' : 's'} waiting for a reply.`), d.incoming.length ? grid : emptyEl());
};

views.chat = async (id) => {
  clearTimers();
  mount(h('p', { class: 'muted' }, 'Loading…'));
  let list; try { list = (await api('GET', '/chats')).chats; } catch (x) { return mount(h('p', { class: 'err' }, x.message)); }
  const sidebar = h('nav', { class: 'list', 'aria-label': 'Your matches' }, list.map((c) => h('a', { class: 'item', href: `#/chat/${c.id}`, 'aria-current': String(c.id) === String(id) }, avatar(c.with), h('div', { class: 'meta' }, h('strong', {}, c.with.name, c.unread ? h('span', { class: 'dot' }, c.unread) : null), h('small', {}, c.last ? (c.last.mine ? 'You: ' : '') + c.last.text : c.with.headline)), h('span', { class: 'badge' }, c.with.score.total + '%'))));
  if (!list.length) return mount(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🧥'), h('h3', {}, 'The coatroom is empty'), h('p', {}, 'Chats open when two people wave at each other.'), h('a', { class: 'btn', href: '#/discover' }, 'Find people')));
  const chat = list.find((c) => String(c.id) === String(id));
  if (!chat) return mount(h('div', { class: 'split chatwrap' }, sidebar, h('div', { class: 'empty' }, h('p', {}, 'Pick a conversation.'))));
  const w = chat.with;
  const msgs = h('div', { class: 'msgs', 'aria-live': 'polite' });
  const input = h('textarea', { 'aria-label': 'Message', maxlength: 1000, placeholder: 'Say something kind…', rows: 1 });
  const err = h('span', { class: 'err small', role: 'alert' });
  let last = 0;
  const addMsg = (m) => {
    last = Math.max(last, m.id);
    msgs.append(h('div', { class: 'msg' + (m.mine ? ' me' : '') }, m.text, h('time', {}, new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))));
    if (m.flags?.length) msgs.append(h('div', { class: 'warnmsg' }, '⚠️ This message uses language scammers often use. Never send money, gift cards or private info. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openReport(w); } }, 'Report')));
  };
  const poll = async () => {
    try { const r = await api('GET', `/chats/${id}/messages?after=${last}`); const stick = msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 40; r.messages.forEach(addMsg); if (r.messages.length && stick) msgs.scrollTop = msgs.scrollHeight; } catch { /* transient */ }
  };
  const send = async () => {
    const text = input.value.trim(); if (!text) return; err.textContent = '';
    try { const r = await api('POST', `/chats/${id}/messages`, { text }); input.value = ''; if (r.warning) toast(r.warning, true); await poll(); msgs.scrollTop = msgs.scrollHeight; } catch (x) { err.textContent = x.message; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  const spotBox = h('div', { class: 'spot', hidden: true });
  const showSpot = async (reroll) => {
    spotBox.hidden = false; spotBox.replaceChildren(h('p', { class: 'muted small' }, 'Rolling the dice…'));
    try {
      const { spot, tips } = await api('GET', `/chats/${id}/spot${reroll ? '?reroll=1' : ''}`);
      if (!spot) { spotBox.replaceChildren(h('p', {}, 'Couldn’t find a suggestion this time.')); return; }
      spotBox.replaceChildren(
        h('h4', {}, spot.emoji, ' ', spot.venue ? spot.venue.name : `Try ${spot.label}`),
        h('p', { class: 'small' }, spot.venue ? `${spot.label[0].toUpperCase()}${spot.label.slice(1)} roughly halfway between you. ` : (spot.offline ? 'Map service is busy, so here’s the kind of place to look for near the middle: ' : 'No listed venue found nearby, so here’s the kind of place to look for: '), `You didn’t list this type of place, but your other interests suggest you’d both enjoy it (${spot.affinity}% fit).`),
        h('div', { class: 'row' }, spot.mapUrl ? h('a', { class: 'btn small soft', href: spot.mapUrl, target: '_blank', rel: 'noopener noreferrer' }, '🗺️ Open map') : null, h('button', { class: 'btn small ghost', onclick: () => showSpot(true) }, '🎲 Another surprise')),
        h('ul', { class: 'small muted' }, tips.slice(0, 3).map((t) => h('li', {}, t))));
    } catch (x) { spotBox.replaceChildren(h('p', { class: 'err' }, x.message)); }
  };
  const head = h('div', { class: 'chathead' },
    h('div', { class: 'row' }, avatar(w), h('div', { style: { 'margin-right': 'auto' } }, h('strong', {}, w.name), h('div', { class: 'small muted' }, [w.ageBand, w.city, w.distance].filter(Boolean).join(' · '))), trustBadge(w.trust), ring(w.score.total)),
    h('div', { class: 'why' }, '💡 ', w.headline),
    h('div', { class: 'chips' }, w.starters.slice(0, 3).map((s) => h('button', { class: 'chip starter', onclick: () => { input.value = s; input.focus(); } }, s))),
    h('div', { class: 'row' },
      h('button', { class: 'btn small soft', onclick: () => showSpot(false) }, '🎲 Surprise Spot to meet'),
      h('button', { class: 'btn small ghost', onclick: async () => { try { await api('POST', `/chats/${id}/vouch`); toast('Thanks — you vouched for ' + w.name + ' 💜'); } catch (x) { toast(x.message, true); } } }, '🤝 Vouch'),
      h('button', { class: 'btn small ghost', onclick: () => openReport(w, () => { location.hash = '#/chat'; }) }, '🚩 Report'),
      h('button', { class: 'btn small ghost', onclick: () => openBlock(w, () => { location.hash = '#/chat'; }) }, '🚫 Block')),
    spotBox);
  mount(h('div', { class: 'split chatwrap' }, sidebar, h('section', { class: 'chatbox', 'aria-label': 'Chat with ' + w.name }, head, msgs, h('div', { class: 'composer' }, input, h('button', { class: 'btn', onclick: send }, 'Send')), err)));
  await poll(); msgs.scrollTop = msgs.scrollHeight;
  S.timers.push(setInterval(() => { if (!document.hidden) poll(); }, 3000));
};

views.safety = () => mount(h('div', { class: 'doc stack' },
  h('h1', {}, 'Safety on PeopleLikeMe'),
  h('p', { class: 'lead muted' }, 'Making friends should feel safe. Here’s what we do — and what you can do.'),
  h('h2', {}, 'How we keep fakes and scams out'),
  h('ul', {}, [
    '18+ only: your date of birth is checked before an account is even created. If someone under 18 is reported, accounts are paused for review.',
    'Email verification is required before anyone can be matched.',
    'No profile photos. Catfishing mostly relies on stolen pictures — here, you’re known by your personality, not a face.',
    'Only mutual waves open a chat. There are no cold messages.',
    'Links are blocked in chat. Messages with money, urgency or “move to WhatsApp” language show a warning to the recipient.',
    'New accounts have lower daily wave limits. Trust badges grow with time, clean conduct and vouches from people who actually chatted.',
    '3 independent scam/fake-profile/harassment reports automatically pause an account until a human reviews it. Three money-request messages in a day do too.',
  ].map((t) => h('li', {}, t))),
  h('h2', {}, 'Meeting in person'),
  h('ul', {}, S.safetyTips.map((t) => h('li', {}, t))),
  h('div', { class: 'callout warn' }, h('strong', {}, 'Red flags: '), 'asking for money or gift cards, refusing to ever meet, a sad emergency story that needs cash, pushing you to leave the app, pressure to hurry. Use 🚩 Report on their card or chat.'),
  h('p', {}, 'If you are ever in danger, contact your local emergency number.')));

views.settings = () => {
  const u = S.user;
  const pw = h('input', { type: 'password', id: 'dp', autocomplete: 'current-password' }); const err = h('p', { class: 'err', role: 'alert' });
  mount(h('div', { class: 'mid stack' },
    h('h2', {}, 'Me'),
    h('div', { class: 'panel stack' }, h('h3', {}, u.name, ' ', h('span', { class: 'muted small' }, `· ${u.ageBand} · ${u.city}`)), h('p', { class: 'muted' }, u.email), h('p', {}, u.bio || ''),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/setup', onclick: () => { S.draft = null; } }, '✏️ Edit profile & answers'), h('a', { class: 'btn ghost', href: '/api/account/export', download: '' }, '⬇️ Download my data'), h('a', { class: 'btn ghost', href: '#/logout' }, 'Sign out'))),
    h('div', { class: 'panel stack' }, h('h3', {}, 'Delete my account'), h('p', { class: 'muted small' }, 'Permanently deletes your profile, answers, chats and messages. This can’t be undone.'),
      h('div', { class: 'field' }, h('label', { for: 'dp' }, 'Confirm your password'), pw), err,
      h('button', { class: 'btn danger', onclick: async () => { try { await api('DELETE', '/account', { password: pw.value }); S.user = null; location.hash = '#/'; toast('Your account was deleted.'); await boot(); } catch (x) { err.textContent = x.message; } } }, 'Delete everything'))));
};

// ---------- router ----------
async function route() {
  clearTimers();
  const [, name = '', arg] = location.hash.replace(/^#/, '').split('/');
  const u = S.user;
  renderTop();
  if (name === 'logout') { await api('POST', '/logout', {}).catch(() => {}); S.user = null; S.draft = null; location.hash = '#/'; return boot(); }
  const open = ['', 'login', 'signup', 'safety'];
  if (!u && !open.includes(name)) return void (location.hash = '#/login');
  if (u && !u.emailVerified && !['verify', 'safety'].includes(name)) return void (location.hash = '#/verify');
  if (u && u.emailVerified && !u.onboarded && !['setup', 'safety'].includes(name)) return void (location.hash = '#/setup');
  if (u && ['', 'login', 'signup'].includes(name)) return void (location.hash = '#/discover');
  const v = { '': 'landing', login: 'login', signup: 'signup', verify: 'verify', setup: 'setup', discover: 'discover', waves: 'waves', chat: 'chat', safety: 'safety', settings: 'settings' }[name];
  if (!v) return void (location.hash = '#/');
  document.title = `${{ landing: 'PeopleLikeMe', chat: 'Coatroom' }[v] || v[0].toUpperCase() + v.slice(1)} · PeopleLikeMe`;
  await views[v](arg);
  $('#main').focus({ preventScroll: true });
}
async function boot() {
  const { user } = await api('GET', '/me'); S.user = user;
  if (user && user.onboarded && user.emailVerified) refreshBadge();
  renderTop();
}
(async () => {
  try {
    [S.meta, { tips: S.safetyTips }] = await Promise.all([api('GET', '/meta'), api('GET', '/safety')]);
    await boot();
  } catch (e) { mount(h('p', { class: 'err' }, 'Can’t reach PeopleLikeMe right now. Please refresh.')); return; }
  window.addEventListener('hashchange', route);
  route();
})();
